import fs from "node:fs";
import path from "node:path";
import { LLMError } from "./llmClient.js";
import {
    fileKind,
    isEditableKind,
    capabilitiesForKind,
    formatFromFilename,
    isAllowedSourceExtension,
} from "./documentTypes.js";
import {
    convertDocxToMarkdown,
    convertExcelToMarkdown,
    convertHtmlFileToPreview,
    extractTextLinesFromContent,
    listExcelSheets,
    getDocxPageMeta as buildDocxPageMeta,
} from "./documentConverters.js";
import { DOCUMENTS_FOLDER, documentsDirPath, documentsModulesDirPath, documentsSourcesDirPath, } from "./paths.js";

function tryFixMojibakeFilename(name) {
    if (/[\u4e00-\u9fff]/.test(name))
        return name;
    try {
        const decoded = Buffer.from(name, "latin1").toString("utf8");
        if (/[\u4e00-\u9fff]/.test(decoded))
            return decoded;
    }
    catch {
        /* ignore */
    }
    return name;
}

const BINARY_LINE_COUNT_KINDS = new Set(["source_pdf", "source_docx", "source_xlsx", "source_xls", "source_csv"]);

function fileMeta(filePath, filesRoot, kind) {
    const stat = fs.statSync(filePath);
    let lineCount = 0;
    const caps = capabilitiesForKind(kind);
    if (caps?.isTextFile !== false && !BINARY_LINE_COUNT_KINDS.has(kind)) {
        try {
            lineCount = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).length;
        }
        catch {
            lineCount = 0;
        }
    }
    const basename = tryFixMojibakeFilename(path.basename(filePath));
    return {
        type: "file",
        name: basename,
        path: path.relative(filesRoot, filePath).replace(/\\/g, "/"),
        kind,
        format: formatFromFilename(path.basename(filePath)),
        capabilities: caps,
        size: stat.size,
        line_count: lineCount,
        updated_at: new Date(stat.mtimeMs).toISOString(),
    };
}

function folderNode(name, children) {
    return { type: "folder", name, children };
}

export function buildMarkdownFilesTree(filesRoot) {
    const root = path.resolve(filesRoot);
    const children = [];
    const sourcesDir = documentsSourcesDirPath(filesRoot);
    if (fs.existsSync(sourcesDir)) {
        const srcFiles = fs
            .readdirSync(sourcesDir)
            .map((f) => path.join(sourcesDir, f))
            .filter((f) => fs.statSync(f).isFile())
            .sort()
            .map((f) => fileMeta(f, root, fileKind(path.basename(f), "sources")))
            .filter((m) => m.kind);
        if (srcFiles.length)
            children.push(folderNode("sources", srcFiles));
    }
    const modulesDir = documentsModulesDirPath(filesRoot);
    if (fs.existsSync(modulesDir)) {
        const modFiles = fs
            .readdirSync(modulesDir)
            .map((f) => path.join(modulesDir, f))
            .filter((f) => fs.statSync(f).isFile())
            .sort()
            .map((f) => fileMeta(f, root, fileKind(path.basename(f), "modules")))
            .filter((m) => m.kind);
        if (modFiles.length)
            children.push(folderNode("modules", modFiles));
    }
    const tree = children.length ? [folderNode(DOCUMENTS_FOLDER, children)] : [];
    return { tree };
}

export function resolveDocumentPath(filesRoot, relPath) {
    const rel = (relPath || "").trim().replace(/\\/g, "/").replace(/^\//, "");
    if (!rel)
        throw new LLMError("path 必填");
    if (`/${rel}/`.includes("/pages/") || rel.endsWith("/pages")) {
        throw new LLMError("不允许访问 pages 目录");
    }
    const parts = rel.split("/");
    if (parts.length !== 3 || parts[0] !== DOCUMENTS_FOLDER)
        throw new LLMError("无效路径");
    const docBase = path.resolve(documentsDirPath(filesRoot));
    const dest = path.resolve(path.join(filesRoot, rel));
    if (!dest.startsWith(docBase))
        throw new LLMError("路径超出 documents 范围");
    if (parts[1] === "sources") {
        const kind = fileKind(parts[2], "sources");
        if (!kind)
            throw new LLMError("不支持的源文件类型");
        return [dest, kind];
    }
    if (parts[1] === "modules" && parts[2].toLowerCase().endsWith(".md")) {
        return [dest, "module_md"];
    }
    throw new LLMError("无效路径");
}

export async function readDocumentContent(filesRoot, relPath) {
    const [dest, kind] = resolveDocumentPath(filesRoot, relPath);
    if (!fs.existsSync(dest))
        throw new LLMError("文件不存在");
    const caps = capabilitiesForKind(kind);
    const format = formatFromFilename(path.basename(dest));
    const base = {
        path: relPath.replace(/\\/g, "/"),
        display_name: tryFixMojibakeFilename(path.basename(dest)),
        kind,
        format,
        editable: caps?.editable ?? false,
        capabilities: caps,
        size: fs.statSync(dest).size,
    };

    if (kind === "source_pdf") {
        throw new LLMError("PDF 请使用预览接口");
    }

    if (kind === "source_docx") {
        const { markdown, warnings, text_lines } = await convertDocxToMarkdown(filesRoot, dest);
        const lines = text_lines?.length ? text_lines : markdown.split(/\r?\n/);
        return {
            ...base,
            content: null,
            markdown,
            preview_html: null,
            text_lines: lines,
            line_count: lines.length,
            warnings,
        };
    }

    if (kind === "source_xlsx" || kind === "source_xls" || kind === "source_csv") {
        const sheets = kind === "source_csv" ? ["CSV"] : listExcelSheets(dest);
        const { preview_html, markdown } = convertExcelToMarkdown(dest, {});
        const lines = markdown ? markdown.split(/\r?\n/) : [];
        return {
            ...base,
            content: null,
            markdown: markdown || "",
            preview_html,
            text_lines: lines,
            line_count: lines.length,
            sheet_names: sheets,
        };
    }

    const text = fs.readFileSync(dest, "utf-8");
    const lines = extractTextLinesFromContent(text, kind);
    const content = kind === "source_json"
        ? (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })()
        : text;

    let preview_html = null;
    if (kind === "source_html") {
        preview_html = convertHtmlFileToPreview(text, filesRoot).preview_html;
    }

    return {
        ...base,
        content,
        markdown: content,
        preview_html,
        text_lines: lines,
        line_count: lines.length,
    };
}

/** @deprecated use readDocumentContent */
export async function readMarkdownContent(filesRoot, relPath) {
    const doc = await readDocumentContent(filesRoot, relPath);
    return {
        path: doc.path,
        kind: doc.kind,
        markdown: doc.markdown ?? doc.content ?? "",
        line_count: doc.line_count,
        size: doc.size,
        ...doc,
    };
}

export async function loadDocxPageInfo(filesRoot, filename) {
    const sourcePath = documentsSourcePath(filesRoot, filename);
    if (!fs.existsSync(sourcePath))
        throw new LLMError("源文件不存在");
    const { markdown } = await convertDocxToMarkdown(filesRoot, sourcePath);
    return buildDocxPageMeta(sourcePath, markdown);
}

export function saveMarkdownContent(filesRoot, relPath, markdown) {
    const [dest, kind] = resolveDocumentPath(filesRoot, relPath);
    if (!isEditableKind(kind))
        throw new LLMError("该文件类型不可编辑，请转 Markdown 后编辑");
    if (kind === "source_json") {
        try {
            JSON.parse(markdown || "{}");
        }
        catch {
            throw new LLMError("JSON 格式无效");
        }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, markdown || "", "utf-8");
    return {
        path: relPath.replace(/\\/g, "/"),
        kind,
        line_count: (markdown || "").split(/\r?\n/).length,
        size: fs.statSync(dest).size,
    };
}

export function deleteDocumentFile(filesRoot, relPath) {
    const [dest, kind] = resolveDocumentPath(filesRoot, relPath);
    if (!fs.existsSync(dest))
        throw new LLMError("文件不存在");
    fs.unlinkSync(dest);
    return { path: relPath.replace(/\\/g, "/"), kind, deleted: true };
}

export function renameDocumentFile(filesRoot, relPath, newName) {
    const [dest, kind] = resolveDocumentPath(filesRoot, relPath);
    if (!fs.existsSync(dest))
        throw new LLMError("文件不存在");
    const safe = (newName || "").trim();
    if (!safe)
        throw new LLMError("name 必填");
    if (safe !== path.basename(safe) || safe.includes("/") || safe.includes("\\") || safe.includes("..")) {
        throw new LLMError("无效文件名");
    }
    if (!isAllowedSourceExtension(safe) && kind.startsWith("source_") && !safe.toLowerCase().endsWith(".md")) {
        const newKind = fileKind(safe, "sources");
        if (!newKind && kind !== "module_md")
            throw new LLMError("不支持的文件扩展名");
    }
    const newDest = path.join(path.dirname(dest), safe);
    if (fs.existsSync(newDest))
        throw new LLMError("目标文件名已存在");
    fs.renameSync(dest, newDest);
    const newKind = fileKind(path.basename(newDest), path.basename(path.dirname(newDest)) === "modules" ? "modules" : "sources") || kind;
    const meta = fileMeta(newDest, path.resolve(filesRoot), newKind);
    return { ...meta, old_path: relPath.replace(/\\/g, "/") };
}

export function createModuleMarkdown(filesRoot, name, markdown = "") {
    let safe = (name || "").trim();
    if (!safe)
        throw new LLMError("name 必填");
    if (!safe.toLowerCase().endsWith(".md"))
        safe = `${safe}.md`;
    if (safe.includes("/") || safe.includes("\\") || safe.includes("..")) {
        throw new LLMError("无效文件名");
    }
    const modulesDir = documentsModulesDirPath(filesRoot);
    fs.mkdirSync(modulesDir, { recursive: true });
    const dest = path.join(modulesDir, safe);
    if (fs.existsSync(dest))
        throw new LLMError("文件已存在");
    fs.writeFileSync(dest, markdown || "", "utf-8");
    const rel = path.relative(path.resolve(filesRoot), dest).replace(/\\/g, "/");
    return {
        path: rel,
        kind: "module_md",
        line_count: (markdown || "").split(/\r?\n/).length,
        size: fs.statSync(dest).size,
    };
}

export function documentsSourcePath(filesRoot, filename) {
    const safe = path.basename(filename);
    if (!safe || safe !== filename)
        throw new LLMError("无效文件名");
    if (!isAllowedSourceExtension(safe) && !safe.toLowerCase().endsWith(".md"))
        throw new LLMError("不支持的文件类型");
    return path.join(documentsSourcesDirPath(filesRoot), safe);
}

export function resolvePreviewFilePath(filesRoot, relPath) {
    const [dest, kind] = resolveDocumentPath(filesRoot, relPath);
    if (kind !== "source_pdf")
        throw new LLMError("仅 PDF 支持文件预览流");
    if (!fs.existsSync(dest))
        throw new LLMError("文件不存在");
    return dest;
}

export { convertDocxToMarkdown, convertExcelToMarkdown, listExcelSheets };
