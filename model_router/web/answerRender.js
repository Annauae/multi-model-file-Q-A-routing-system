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

function renderDisplayAnswerHtml(text, sourceFile = "") {
  const src = (sourceFile || "").trim();
  if (src && /!\[[^\]]*\]\([^)]+\)/.test(text || "")) {
    return renderAnswerWithMedia(text, src);
  }
  return renderAnswerText(stripCitationLines(text));
}
