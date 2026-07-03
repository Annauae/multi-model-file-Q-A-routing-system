import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import mammoth from "mammoth";
import TurndownService from "turndown";
import XLSX from "xlsx";
import JSZip from "jszip";
import { LLMError } from "./llmClient.js";
import { documentsAssetsDirPath } from "./paths.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function hashBuffer(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

function ensureAssetsDir(filesRoot) {
    const dir = documentsAssetsDirPath(filesRoot);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function saveImageBuffer(filesRoot, buffer, contentType) {
    const assetsDir = ensureAssetsDir(filesRoot);
    const ext = contentType?.includes("png") ? "png"
        : contentType?.includes("jpeg") || contentType?.includes("jpg") ? "jpg"
            : contentType?.includes("gif") ? "gif"
                : contentType?.includes("webp") ? "webp"
                    : "png";
    const name = `${hashBuffer(buffer)}.${ext}`;
    const dest = path.join(assetsDir, name);
    if (!fs.existsSync(dest))
        fs.writeFileSync(dest, buffer);
    return `assets/${name}`;
}

export function rewriteHtmlAssetRefs(html, _filesRoot) {
    return String(html || "").replace(
        /(<img[^>]+src=["'])(?!https?:|data:)([^"']+)(["'])/gi,
        (_m, pre, ref, post) => {
            let r = ref.trim().replace(/\\/g, "/");
            if (r.startsWith("../"))
                r = r.slice(3);
            if (!r.startsWith("assets/"))
                r = r.includes("/") ? r : `assets/${r}`;
            return `${pre}${r}${post}`;
        },
    );
}

const MAMMOTH_NOISE_PATTERNS = [
    /unrecognised element was ignored/i,
    /unrecognised paragraph style/i,
    /image\/x-wmf/i,
    /image\/x-emf/i,
    /unlikely to display in web browsers/i,
];

function collectMammothWarnings(messages, warnings) {
    let noiseCount = 0;
    for (const msg of messages || []) {
        const text = String(msg.message || msg);
        if (MAMMOTH_NOISE_PATTERNS.some((p) => p.test(text)))
            noiseCount++;
        else if (text)
            warnings.push(text);
    }
    if (noiseCount > 0)
        warnings.push("Word 含部分不兼容元素，已忽略，不影响正文转换");
}

function isVectorImageContentType(contentType) {
    return /wmf|emf/i.test(String(contentType || ""));
}

export async function convertDocxToMarkdown(filesRoot, sourcePath) {
    const warnings = [];
    const imageRefs = [];
    let skippedVectorImage = false;
    const result = await mammoth.convertToMarkdown(
        { path: sourcePath },
        {
            convertImage: mammoth.images.imgElement(async (image) => {
                if (isVectorImageContentType(image.contentType)) {
                    if (!skippedVectorImage) {
                        warnings.push("WMF/EMF 矢量图无法在网页显示，已跳过");
                        skippedVectorImage = true;
                    }
                    return { src: "" };
                }
                const buffer = await image.read();
                const ref = saveImageBuffer(filesRoot, buffer, image.contentType);
                imageRefs.push(ref);
                return { src: ref };
            }),
        },
    );
    collectMammothWarnings(result.messages, warnings);
    let md = String(result.value || "").trim();
    return { markdown: md, preview_html: null, text_lines: md.split(/\r?\n/), warnings, imageRefs };
}

export async function convertDocxToHtml(filesRoot, sourcePath) {
    const warnings = [];
    const result = await mammoth.convertToHtml(
        { path: sourcePath },
        {
            convertImage: mammoth.images.imgElement(async (image) => {
                const buffer = await image.read();
                const ref = saveImageBuffer(filesRoot, buffer, image.contentType);
                return { src: ref };
            }),
        },
    );
    if (result.messages?.length) {
        for (const msg of result.messages)
            warnings.push(String(msg.message || msg));
    }
    const html = rewriteHtmlAssetRefs(result.value || "", filesRoot);
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const text_lines = text ? text.split(/\r?\n/) : html.split(/\r?\n/);
    return { preview_html: html, text_lines, warnings };
}

function escapeMdCell(val) {
    return String(val ?? "")
        .replace(/\|/g, "\\|")
        .replace(/\r?\n/g, " ");
}

function sheetToMarkdownTable(rows) {
    if (!rows.length)
        return "";
    const maxCols = Math.max(...rows.map((r) => r.length));
    const normalized = rows.map((r) => {
        const row = [...r];
        while (row.length < maxCols)
            row.push("");
        return row.map(escapeMdCell);
    });
    const header = normalized[0];
    const sep = header.map(() => "---");
    const lines = [
        `| ${header.join(" | ")} |`,
        `| ${sep.join(" | ")} |`,
        ...normalized.slice(1).map((r) => `| ${r.join(" | ")} |`),
    ];
    return lines.join("\n");
}

function readExcelWorkbook(sourcePath) {
    const buf = fs.readFileSync(sourcePath);
    return XLSX.read(buf, { type: "buffer", cellDates: true });
}

export function listExcelSheets(sourcePath) {
    return readExcelWorkbook(sourcePath).SheetNames;
}

export function convertExcelToMarkdown(sourcePath, { sheetName, rowStart = 1, rowEnd = null, maxRows = 5000 } = {}) {
    const warnings = [];
    const wb = readExcelWorkbook(sourcePath);
    const names = wb.SheetNames;
    if (!names.length)
        throw new LLMError("Excel 文件无工作表");
    const sheet = sheetName && names.includes(sheetName) ? sheetName : names[0];
    if (sheetName && !names.includes(sheetName))
        warnings.push(`工作表「${sheetName}」不存在，已使用「${sheet}」`);
    const ws = wb.Sheets[sheet];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const start = Math.max(1, rowStart);
    const end = rowEnd != null ? Math.min(raw.length, rowEnd) : raw.length;
    if (end < start)
        throw new LLMError("无效行范围");
    if (end - start + 1 > maxRows) {
        warnings.push(`行数超过 ${maxRows}，已截断`);
    }
    const slice = raw.slice(start - 1, Math.min(end, start - 1 + maxRows));
    const md = sheetToMarkdownTable(slice);
    if (!md)
        warnings.push("选定范围无表格内容");
    warnings.push("Excel 嵌入图片通常无法导出，含图表格建议改用 PDF/Word");
    return { markdown: md, sheet, warnings, preview_html: sheetToHtmlTable(slice) };
}

function sheetToHtmlTable(rows) {
    if (!rows.length)
        return "<p class=\"muted\">（空表格）</p>";
    const body = rows.map((row, i) => {
        const tag = i === 0 ? "th" : "td";
        const cells = row.map((c) => `<${tag}>${escapeHtml(String(c ?? ""))}</${tag}>`).join("");
        return `<tr>${cells}</tr>`;
    }).join("");
    return `<table class="docPreviewTable"><tbody>${body}</tbody></table>`;
}

function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function convertHtmlToMarkdown(html, { lineStart, lineEnd } = {}) {
    const warnings = [];
    let src = String(html || "");
    if (lineStart != null && lineEnd != null) {
        const lines = src.split(/\r?\n/);
        src = lines.slice(Math.max(0, lineStart - 1), lineEnd).join("\n");
    }
    const md = turndown.turndown(src);
    return { markdown: md.trim(), warnings };
}

export function convertHtmlFileToPreview(htmlContent, filesRoot) {
    const html = rewriteHtmlAssetRefs(htmlContent, filesRoot);
    return { preview_html: html, text_lines: html.split(/\r?\n/) };
}

export function extractTextLinesFromContent(content, kind) {
    const text = String(content || "");
    if (kind === "source_json") {
        try {
            return JSON.stringify(JSON.parse(text), null, 2).split(/\r?\n/);
        }
        catch {
            return text.split(/\r?\n/);
        }
    }
    return text.split(/\r?\n/);
}

export function collectImageRefsFromMarkdown(md) {
    const refs = [];
    const re = /!\[[^\]]*\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(md || "")) !== null) {
        const ref = m[1].trim();
        if (ref && !ref.startsWith("http"))
            refs.push(ref);
    }
    return refs;
}

const PAGE_BREAK_RE = /<w:br[^>]*w:type=["']page["']|<w:lastRenderedPageBreak\b/;

export async function parseDocxParagraphPages(sourcePath) {
    const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml)
        return { pageCount: 1, paragraphPages: [1] };
    const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
    let page = 1;
    const paragraphPages = [];
    for (const p of paragraphs) {
        paragraphPages.push(page);
        if (PAGE_BREAK_RE.test(p))
            page++;
    }
    return { pageCount: Math.max(1, page), paragraphPages };
}

export function mapDocxPagesToLineRanges(markdown, paragraphPages) {
    const lines = String(markdown || "").split(/\r?\n/);
    const blocks = String(markdown || "").split(/\n\n+/);
    const blockStartLines = [];
    let pos = 0;
    for (let i = 0; i < blocks.length; i++) {
        blockStartLines.push(pos + 1);
        pos += blocks[i].split(/\r?\n/).length;
        if (i + 1 < blocks.length && pos < lines.length)
            pos += 1;
    }
    const pageCount = Math.max(1, ...paragraphPages, 1);
    const pages = [];
    for (let p = 1; p <= pageCount; p++) {
        let lineStart = null;
        let lineEnd = null;
        for (let i = 0; i < blocks.length; i++) {
            const pg = paragraphPages[i] ?? paragraphPages[paragraphPages.length - 1] ?? 1;
            if (pg !== p)
                continue;
            const start = blockStartLines[i] ?? 1;
            const end = i + 1 < blockStartLines.length ? blockStartLines[i + 1] - 1 : lines.length;
            lineStart = lineStart == null ? start : Math.min(lineStart, start);
            lineEnd = lineEnd == null ? end : Math.max(lineEnd, end);
        }
        pages.push({
            page: p,
            line_start: lineStart ?? 1,
            line_end: lineEnd ?? Math.max(1, lines.length),
        });
    }
    return { page_count: pageCount, pages };
}

export async function getDocxPageMeta(sourcePath, markdown) {
    const { pageCount, paragraphPages } = await parseDocxParagraphPages(sourcePath);
    const mapped = mapDocxPagesToLineRanges(markdown, paragraphPages);
    return { page_count: pageCount, pages: mapped.pages, paragraphPages };
}

export function sliceMarkdownByDocxPages(markdown, paragraphPages, pageStart, pageEnd) {
    const blocks = String(markdown || "").split(/\n\n+/);
    const selected = [];
    for (let i = 0; i < blocks.length; i++) {
        const pg = paragraphPages[i] ?? paragraphPages[paragraphPages.length - 1] ?? 1;
        if (pg >= pageStart && pg <= pageEnd)
            selected.push(blocks[i]);
    }
    return selected.join("\n\n").trim();
}
