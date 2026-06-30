import fs from "node:fs";
import path from "node:path";
import { LLMError } from "./llmClient.js";
import { DOCUMENTS_FOLDER, documentsDirPath, documentsModulesDirPath, documentsSourcesDirPath, } from "./paths.js";
function fileKind(name, parent) {
    const lower = name.toLowerCase();
    if (parent === "sources") {
        if (lower.endsWith(".pdf"))
            return "source_pdf";
        if (lower.endsWith(".md"))
            return "source_md";
        return null;
    }
    if (parent === "modules" && lower.endsWith(".md"))
        return "module_md";
    return null;
}
function fileMeta(filePath, filesRoot, kind) {
    const stat = fs.statSync(filePath);
    let lineCount = 0;
    if (kind !== "source_pdf") {
        try {
            lineCount = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).length;
        }
        catch {
            lineCount = 0;
        }
    }
    return {
        type: "file",
        name: path.basename(filePath),
        path: path.relative(filesRoot, filePath).replace(/\\/g, "/"),
        kind,
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
export function readMarkdownContent(filesRoot, relPath) {
    const [dest, kind] = resolveDocumentPath(filesRoot, relPath);
    if (kind === "source_pdf")
        throw new LLMError("PDF 文件不可作为 Markdown 读取");
    if (!fs.existsSync(dest))
        throw new LLMError("文件不存在");
    const text = fs.readFileSync(dest, "utf-8");
    return {
        path: relPath.replace(/\\/g, "/"),
        kind,
        markdown: text,
        line_count: text ? text.split(/\r?\n/).length : 0,
        size: fs.statSync(dest).size,
    };
}
export function saveMarkdownContent(filesRoot, relPath, markdown) {
    const [dest, kind] = resolveDocumentPath(filesRoot, relPath);
    if (kind === "source_pdf")
        throw new LLMError("PDF 文件不可编辑为 Markdown");
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
    const newDest = path.join(path.dirname(dest), safe);
    if (fs.existsSync(newDest))
        throw new LLMError("目标文件名已存在");
    fs.renameSync(dest, newDest);
    const meta = fileMeta(newDest, path.resolve(filesRoot), kind);
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
    return path.join(documentsSourcesDirPath(filesRoot), safe);
}
