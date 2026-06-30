import crypto from "node:crypto";

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const HTML_TAG_RE = /<[^>]+>/g;
const PUNCT_RE = /[\s\W_]+/gu;

function htmlUnescape(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function stableHash(text) {
    return crypto.createHash("sha256").update(text || "", "utf-8").digest("hex");
}

export function stripMarkdown(text) {
    let s = text || "";
    s = s.replace(MD_IMAGE_RE, (_, alt, src) => `${alt} ${src}`);
    s = s.replace(/`([^`]+)`/g, "$1");
    s = s.replace(/[*_#>|~\-]+/g, " ");
    s = s.replace(HTML_TAG_RE, " ");
    s = htmlUnescape(s);
    s = s.replace(/\s+/g, " ");
    return s.trim();
}

export function answerSummary(answer, maxChars = 900) {
    const text = stripMarkdown(answer);
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

export function normalizeQuery(text) {
    return (text || "").trim().replace(/\s+/g, " ");
}

export function charNgrams(text, minN = 2, maxN = 3) {
    const cleaned = (text || "").toLowerCase().replace(PUNCT_RE, "");
    const tokens = [];
    for (let n = minN; n <= maxN; n++) {
        if (cleaned.length < n)
            continue;
        for (let i = 0; i <= cleaned.length - n; i++) {
            tokens.push(cleaned.slice(i, i + n));
        }
    }
    const words = (text || "").toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
    tokens.push(...words);
    return tokens;
}

export function keywordText(texts) {
    const toks = [];
    for (const text of texts) {
        toks.push(...charNgrams(text));
    }
    return toks.join(" ");
}

export function clipText(text, limit) {
    const s = (text || "").trim();
    if (s.length <= limit)
        return s;
    return `${s.slice(0, limit - 1).trimEnd()}…`;
}

export function msSince(t0) {
    return Math.round((performance.now() - t0) * 10) / 10;
}
