/** 文档中心：使用者手册 + 开发者文档 */

import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";

const MANUAL_VERSION = 16;

type DocKind = "user" | "developer";

const DOC_SOURCES: Record<DocKind, { path: string; label: string }> = {
  user: { path: "/static/manual.md", label: "使用指南" },
  developer: { path: "/static/dev-manual.md", label: "开发者文档" },
};

function buildToc(md: string, includeH4: boolean) {
  const parsed = marked.parse(md) as string;
  const clean = DOMPurify.sanitize(parsed);
  const div = document.createElement("div");
  div.innerHTML = clean;
  const headings: { id: string; text: string; level: number }[] = [];
  const selector = includeH4 ? "h2, h3, h4" : "h2, h3";
  div.querySelectorAll(selector).forEach((h, i) => {
    const id = `h-${i}`;
    h.id = id;
    const level = h.tagName === "H2" ? 2 : h.tagName === "H3" ? 3 : 4;
    headings.push({ id, text: h.textContent || "", level });
  });
  return { html: div.innerHTML, toc: headings };
}

/** 文档中心弹窗 */
export function DocsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [docKind, setDocKind] = useState<DocKind>("user");
  const [html, setHtml] = useState("");
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const anim = useAnimatedVisible(open);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const src = DOC_SOURCES[docKind];
    void fetch(`${src.path}?v=${MANUAL_VERSION}`)
      .then((r) => {
        if (!r.ok) throw new Error(`加载失败: ${r.status}`);
        return r.text();
      })
      .then((md) => {
        const { html: built, toc: headings } = buildToc(md, docKind === "developer");
        setHtml(built);
        setToc(headings);
      })
      .catch(() => {
        setHtml("<p class=\"muted\">文档加载失败，请确认服务已启动。</p>");
        setToc([]);
      })
      .finally(() => setLoading(false));
  }, [open, docKind]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!anim.mounted) return null;

  return (
    <div className={`docsOverlay ${anim.animClass}`} id="docsOverlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal docsModal ${anim.animClass}`}>
        <div className="modalHead">
          <h3>文档中心</h3>
          <button type="button" id="docsCloseBtn" className="btn btnXs ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="docsLayout docsLayoutWide">
          <nav className="docsDocNav" id="docsDocNav">
            <div className="docsDocNavTitle">文档</div>
            {(Object.keys(DOC_SOURCES) as DocKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`docsDocNavItem${docKind === kind ? " active" : ""}`}
                onClick={() => setDocKind(kind)}
              >
                {DOC_SOURCES[kind].label}
              </button>
            ))}
          </nav>
          <nav className="docsToc" id="docsToc">
            <div className="docsTocTitle">目录</div>
            {loading ? (
              <div className="docsTocEmpty muted">加载中…</div>
            ) : toc.length ? (
              <ul className="docsTocList">
                {toc.map((h) => (
                  <li key={h.id} className={`docsTocItem docsTocH${h.level}`}>
                    <a
                      href={`#${h.id}`}
                      onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth" }); }}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="docsTocEmpty muted">无目录</div>
            )}
          </nav>
          <div className="docsBody markdownBody scrollInner" id="docsBody" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  );
}
