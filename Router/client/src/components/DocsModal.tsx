import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

const MANUAL_VERSION = 8;

export function DocsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [html, setHtml] = useState("");
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);

  useEffect(() => {
    if (!open) return;
    void fetch(`/static/manual.md?v=${MANUAL_VERSION}`)
      .then((r) => r.text())
      .then((md) => {
        const parsed = marked.parse(md) as string;
        const clean = DOMPurify.sanitize(parsed);
        setHtml(clean);
        const div = document.createElement("div");
        div.innerHTML = clean;
        const headings: { id: string; text: string; level: number }[] = [];
        div.querySelectorAll("h2, h3").forEach((h, i) => {
          const id = `h-${i}`;
          h.id = id;
          headings.push({ id, text: h.textContent || "", level: h.tagName === "H2" ? 2 : 3 });
        });
        setHtml(div.innerHTML);
        setToc(headings);
      });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modalOverlay" id="docsOverlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal docsModal modalWide modalTall">
        <div className="modalHead">
          <h3>使用手册</h3>
          <button type="button" id="docsCloseBtn" className="btn btnXs ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="docsLayout">
          <nav className="docsToc" id="docsToc">
            <ul className="docsTocList">
              {toc.map((h) => (
                <li key={h.id} className={`docsTocItem docsTocH${h.level}`}>
                  <a href={`#${h.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth" }); }}>{h.text}</a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="docsBody markdownBody scrollInner" id="docsBody" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  );
}
