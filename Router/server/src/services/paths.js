import fs from "node:fs";
import path from "node:path";
import { APP_ROOT } from "../config.js";
export const DOCUMENTS_FOLDER = "documents";
export function kbFolderName(kbId) {
    return `kb_${kbId}`;
}
export function ragKbFolderName(kbId) {
    return `rag_kb_${kbId}`;
}
export function kbDirPath(filesRoot, kbId) {
    return path.join(filesRoot, kbFolderName(kbId));
}
export function ragKbDirPath(filesRoot, kbId) {
    return path.join(filesRoot, ragKbFolderName(kbId));
}
export function ragKbAssetsDirPath(filesRoot, kbId) {
    return path.join(ragKbDirPath(filesRoot, kbId), "assets");
}
export function kbAssetsDirPath(filesRoot, kbId) {
    return path.join(kbDirPath(filesRoot, kbId), "assets");
}
export function kbModulesDirPath(filesRoot, kbId) {
    return path.join(kbDirPath(filesRoot, kbId), "modules");
}
export function ragDirPath(filesRoot, kbId) {
    return ragKbDirPath(filesRoot, kbId);
}

/** 将旧版 files/kb_{id}/rag/ 迁移到 files/rag_kb_{id}/ */
export async function migrateLegacyRagKbData(filesRoot, ragKbStore) {
    if (!fs.existsSync(filesRoot))
        return;
    for (const entry of fs.readdirSync(filesRoot)) {
        const m = /^kb_(\d+)$/.exec(entry);
        if (!m)
            continue;
        const kbId = m[1];
        const legacyDir = path.join(filesRoot, entry, "rag");
        const newDir = ragKbDirPath(filesRoot, kbId);
        if (fs.existsSync(legacyDir) && !fs.existsSync(newDir)) {
            fs.cpSync(legacyDir, newDir, { recursive: true });
        }
        if (fs.existsSync(newDir) && !ragKbStore.get(kbId)) {
            await ragKbStore.createKb(kbId, `RAG 知识库 ${kbId}`);
        }
    }
}
export function documentsDirPath(filesRoot) {
    return path.join(filesRoot, DOCUMENTS_FOLDER);
}
export function documentsSourcesDirPath(filesRoot) {
    return path.join(documentsDirPath(filesRoot), "sources");
}
export function documentsModulesDirPath(filesRoot) {
    return path.join(documentsDirPath(filesRoot), "modules");
}
export function documentsAssetsDirPath(filesRoot) {
    return path.join(documentsDirPath(filesRoot), "assets");
}
export const PDF_EXTRACT_ROOT = path.join(APP_ROOT, "server", "pdf_extract");
export const DOCLING_SCRIPT = path.join(PDF_EXTRACT_ROOT, "scripts", "docling_extract_pages.py");
