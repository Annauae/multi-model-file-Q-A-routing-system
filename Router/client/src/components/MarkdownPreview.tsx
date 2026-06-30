import { marked } from "marked";
import DOMPurify from "dompurify";
import { escapeHtml } from "../api/client";

function assetPreviewUrl(kbId: string, ref: string): string {
  let r = String(ref || "").trim();
  if (!r) return r;
  if (r.startsWith("http://") || r.startsWith("https://")) return r;
  if (r.startsWith("../")) r = r.slice(3);
  const scope = String(kbId || "").trim();
  if (scope === "documents") {
    return `/documents/preview-asset?ref=${encodeURIComponent(r)}`;
  }
  if (!scope) return r;
  return `/preview-asset?kb_id=${encodeURIComponent(scope)}&ref=${encodeURIComponent(r)}`;
}

function stripCitationLines(text: string): string {
  return (text ?? "")
    .split("\n")
    .filter((line) => !/【引用】|【原文】/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isImageRef(url: string): boolean {
  return /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url || "");
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function renderAnswerText(s: string): string {
  const text = s ?? "";
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
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

function renderAnswerWithMedia(text: string, kbId: string): string {
  const body = stripCitationLines(text);
  if (!body) return "";
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
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

export function renderMarkdownPreview(md: string, kbId: string): string {
  const withMedia = renderAnswerWithMedia(md, kbId);
  const html = marked.parse(withMedia, { breaks: true }) as string;
  return DOMPurify.sanitize(html);
}

export function MarkdownPreview({ md, kbId, className = "mdPreview" }: { md: string; kbId: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(md, kbId) }} />;
}
