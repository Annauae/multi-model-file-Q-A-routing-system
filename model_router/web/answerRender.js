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

/** Render answer: text + inline ![](assets/...) images; strip 【引用】 lines. */
function renderAnswerWithMedia(text, sourceFile) {
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
    const src = assetPreviewUrl(sourceFile, ref);
    if (isImageRef(ref) || isImageRef(src)) {
      result += `<figure class="answerFigure"><a class="answerFigureLink" href="${escapeHtml(
        src
      )}" target="_blank" rel="noopener noreferrer"><img loading="lazy" alt="${escapeHtml(
        alt
      )}" src="${escapeHtml(src)}" /></a><figcaption>${escapeHtml(alt || ref)}</figcaption></figure>`;
    } else {
      result += escapeHtml(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  result += renderAnswerText(body.slice(lastIndex));
  return result;
}

/** Escape text, then turn [label](https://...) into clickable links. */
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
      const safeUrl = escapeHtml(url);
      result += `<a class="answerLink" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        label
      )}</a>`;
    } else {
      result += escapeHtml(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function normalizeAnswerMarkdownImages(md) {
  let s = md || "";
  if (!s.trim()) return s;
  s = s.replace(
    /\[[^\]]*\]\s*([^\n!\[]+?)!\[\]\((assets\/[^)\s]+)\)/gi,
    (_m, alt, ref) => `\n\n![${alt.trim()}](${ref.trim()})\n\n`
  );
  s = s.replace(
    /([^\n!\[\]]{2,}?)!\[\]\((assets\/[^)\s]+)\)/g,
    (_m, alt, ref) => `\n\n![${alt.trim()}](${ref.trim()})\n\n`
  );
  while (s.includes("\n\n\n")) s = s.replace(/\n\n\n/g, "\n\n");
  return s.trim();
}

function renderAnswerMarkdownPreview(text, sourceFile = "") {
  const body = normalizeAnswerMarkdownImages(stripCitationLines(text));
  if (!body) return `<div class="empty">（空）</div>`;
  if (typeof renderMarkdownPreview === "function") {
    return renderMarkdownPreview(body, (sourceFile || "").trim());
  }
  return renderDisplayAnswerHtml(body, sourceFile);
}

function renderDisplayAnswerHtml(text, sourceFile = "") {
  const src = (sourceFile || "").trim();
  const normalized = normalizeAnswerMarkdownImages(text);
  if (src && /!\[[^\]]*\]\([^)]+\)/.test(normalized || "")) {
    return renderAnswerWithMedia(normalized, src);
  }
  return renderAnswerText(stripCitationLines(normalized));
}
