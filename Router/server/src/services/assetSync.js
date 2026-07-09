import fs from "node:fs";
import path from "node:path";
import { collectImageRefsFromMarkdown } from "./documentConverters.js";
import { documentsAssetsDirPath, kbAssetsDirPath, ragKbAssetsDirPath } from "./paths.js";

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_IMG_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

/** 规范化为 assets/ 相对路径 */
export function normalizeAssetRef(ref) {
    let r = String(ref || "").trim().replace(/\\/g, "/");
    if (!r || r.startsWith("http://") || r.startsWith("https://") || r.startsWith("data:")) return r;
    if (r.startsWith("/preview-asset") || r.startsWith("/documents/preview-asset")) return r;
    if (r.startsWith("/assets/")) r = r.slice(1);
    if (r.startsWith("./assets/")) r = r.slice(2);
    if (r.startsWith("../")) return r;
    if (!r.startsWith("assets/")) r = `assets/${path.posix.basename(r)}`;
    return r;
}

/** 从 Markdown 收集图片引用（含 HTML img） */
export function collectAssetRefsFromText(text) {
    const refs = new Set();
    const src = text || "";
    for (const ref of collectImageRefsFromMarkdown(src)) {
        const n = normalizeAssetRef(ref);
        if (n && !n.startsWith("http")) refs.add(n);
    }
    for (const m of src.matchAll(HTML_IMG_RE)) {
        const n = normalizeAssetRef(m[1]);
        if (n && !n.startsWith("http")) refs.add(n);
    }
    return [...refs];
}

/** 将正文中的图片路径统一为 assets/ 前缀 */
export function rewriteAssetPathsInText(text) {
    let out = text || "";
    out = out.replace(MD_IMAGE_RE, (full, alt, ref) => {
        const n = normalizeAssetRef(ref);
        if (n.startsWith("http")) return full;
        return `![${alt}](${n})`;
    });
    out = out.replace(HTML_IMG_RE, (tag, ref) => {
        const n = normalizeAssetRef(ref);
        if (n.startsWith("http")) return tag;
        return tag.replace(ref, n);
    });
    return out;
}

function assetFileName(ref) {
    const n = normalizeAssetRef(ref);
    return n.startsWith("assets/") ? n.slice("assets/".length) : path.posix.basename(n);
}

function resolveAssetSource(filesRoot, fileName) {
    const candidates = [
        path.join(documentsAssetsDirPath(filesRoot), fileName),
    ];
    const root = path.resolve(filesRoot);
    if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root)) {
            if (entry.startsWith("kb_") || entry.startsWith("rag_kb_")) {
                candidates.push(path.join(root, entry, "assets", fileName));
            }
        }
    }
    return candidates.find((p) => fs.existsSync(p)) || null;
}

/** 将 assets/ 引用的文件复制到目标 assets 目录（已存在则跳过） */
export function copyAssetRefsToDir(filesRoot, refs, destAssetsDir) {
    fs.mkdirSync(destAssetsDir, { recursive: true });
    let copied = 0;
    for (const ref of refs) {
        const fileName = assetFileName(ref);
        const dest = path.join(destAssetsDir, fileName);
        if (fs.existsSync(dest)) {
            copied += 1;
            continue;
        }
        const src = resolveAssetSource(filesRoot, fileName);
        if (!src) continue;
        fs.copyFileSync(src, dest);
        copied += 1;
    }
    return copied;
}

/** 复制目录下所有文件到 documents/assets（不覆盖已有） */
export function copyDirAssetsToDocuments(filesRoot, srcDir) {
    if (!srcDir || !fs.existsSync(srcDir)) return 0;
    const destDir = documentsAssetsDirPath(filesRoot);
    fs.mkdirSync(destDir, { recursive: true });
    let n = 0;
    for (const entry of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, entry);
        if (!fs.statSync(src).isFile()) continue;
        const dest = path.join(destDir, entry);
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
        n += 1;
    }
    return n;
}

/** 将 FAQ 答案引用的图片同步到知识库 assets */
export function syncAnswerAssetsToKb(filesRoot, kbId, answerMd, { rag = false } = {}) {
    const refs = collectAssetRefsFromText(answerMd);
    if (!refs.length) return 0;
    const dest = rag
        ? ragKbAssetsDirPath(filesRoot, kbId)
        : kbAssetsDirPath(filesRoot, kbId);
    return copyAssetRefsToDir(filesRoot, refs, dest);
}
