/**
 * filePreview.js — Markdown 预览与 assets 图片 URL 解析（kb_id + ref → /preview-asset）
 */
function normalizeAssetRef(ref) {
  const r = (ref || "").trim().replace(/\\/g, "/");
  if (r.startsWith("../assets/")) return r.slice(3);
  return r;
}

function assetPreviewUrl(kbId, ref) {
  const r = normalizeAssetRef(ref);
  if (!r) return "";
  if (isSafeHttpUrl(r)) return r;
  const kid = (kbId || getSelectedKbIdFrom($("#kbSelect")) || currentKbId || "").trim();
  if (kid) {
    return `/preview-asset?kb_id=${encodeURIComponent(kid)}&ref=${encodeURIComponent(r)}`;
  }
  return r;
}

function renderMarkdownPreview(md, kbId) {
  if (typeof marked === "undefined") {
    return `<div class="empty">marked.js 未加载</div>`;
  }
  const renderer = new marked.Renderer();
  renderer.image = (href, title, text) => {
    const resolved = assetPreviewUrl(kbId, href);
    const alt = escapeHtml(text || title || "");
    return `<img loading="lazy" alt="${alt}" src="${escapeHtml(resolved)}" />`;
  };
  renderer.link = (href, title, text) => {
    const url = (href || "").trim();
    if (isSafeHttpUrl(url)) {
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text || title || url)}</a>`;
    }
    return escapeHtml(text || href || "");
  };
  const raw = marked.parse(md || "", { renderer, breaks: true });
  const clean = typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(raw) : raw;
  return clean;
}
