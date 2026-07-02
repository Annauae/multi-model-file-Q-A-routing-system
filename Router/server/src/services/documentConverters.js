import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import mammoth from "mammoth";
import TurndownService from "turndown";
import * as XLSX from "xlsx";
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

export async function convertDocxToMarkdown(filesRoot, sourcePath) {
    const warnings = [];
    const imageRefs = [];
    const result = await mammoth.convertToMarkdown(
        { path: sourcePath },
        {
            convertImage: mammoth.images.imgElement(async (image) => {
                const buffer = await image.read();
                const ref = saveImageBuffer(filesRoot, buffer, image.contentType);
                imageRefs.push(ref);
                return { src: ref };
            }),
        },
    );
    if (result.messages?.length) {
        for (const msg of result.messages)
            warnings.push(String(msg.message || msg));
    }
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

export function listExcelSheets(sourcePath) {
    const wb = XLSX.readFile(sourcePath, { cellDates: true });
    return wb.SheetNames;
}

export function convertExcelToMarkdown(sourcePath, { sheetName, rowStart = 1, rowEnd = null, maxRows = 5000 } = {}) {
    const warnings = [];
    const wb = XLSX.readFile(sourcePath, { cellDates: true });
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
