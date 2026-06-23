function assetPreviewUrl(kbId, ref) {
  const kid = String(kbId || "").trim();
  let r = String(ref || "").trim();
  if (!kid || !r) return r;
  if (r.startsWith("http://") || r.startsWith("https://")) return r;
  if (r.startsWith("../")) r = r.slice(3);
  return `/preview-asset?kb_id=${encodeURIComponent(kid)}&ref=${encodeURIComponent(r)}`;
}

function stripCitationLines(text) {
  return (text ?? "")
    .split("\n")
    .filter((line) => !/【引用】|【原文】/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isImageRef(url) {
  return /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url || "");
}

function isSafeHttpUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function renderAnswerText(s) {
  const text = s ?? "";
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = linkRe.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    const label = match[1];
    const url = match[2].trim();
    if (isSafeHttpUrl(url)) {
      result += `<a class="answerLink" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
    } else {
      result += escapeHtml(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function renderAnswerWithMedia(text, kbId) {
  const body = stripCitationLines(text);
  if (!body) return "";
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = imgRe.exec(body)) !== null) {
    result += renderAnswerText(body.slice(lastIndex, match.index)).replace(/\n$/, "");
    const alt = match[1];
    const ref = match[2].trim();
    const src = assetPreviewUrl(kbId, ref);
    if (isImageRef(ref) || isImageRef(src)) {
      result += `<figure class="answerFigure"><a href="${escapeHtml(src)}" target="_blank" rel="noopener"><img loading="lazy" alt="${escapeHtml(alt)}" src="${escapeHtml(src)}" /></a><figcaption>${escapeHtml(alt || ref)}</figcaption></figure>`;
    } else {
      result += escapeHtml(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  result += renderAnswerText(body.slice(lastIndex));
  return result;
}

function renderMarkdownPreview(md, kbId) {
  const withMedia = renderAnswerWithMedia(md, kbId);
  if (typeof marked !== "undefined") {
    const html = marked.parse(withMedia, { breaks: true });
    return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(html) : html;
  }
  return withMedia;
}
