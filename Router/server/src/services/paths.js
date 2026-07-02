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
export function questionsJsonPath(filesRoot, kbId) {
    return path.join(kbDirPath(filesRoot, kbId), "questions.json");
}
export function kbAssetsDirPath(filesRoot, kbId) {
    return path.join(kbDirPath(filesRoot, kbId), "assets");
}
export function kbModulesDirPath(filesRoot, kbId) {
    return path.join(kbDirPath(filesRoot, kbId), "modules");
}
export function recallTestsJsonPath(filesRoot, kbId) {
    return path.join(kbDirPath(filesRoot, kbId), "recall_tests.json");
}
export function ragDirPath(filesRoot, kbId) {
    return ragKbDirPath(filesRoot, kbId);
}
export function ragQuestionsJsonPath(filesRoot, kbId) {
    return path.join(ragKbDirPath(filesRoot, kbId), "questions.json");
}
export function ragRecallTestsJsonPath(filesRoot, kbId) {
    return path.join(ragKbDirPath(filesRoot, kbId), "recall_tests.json");
}
export function ragRuntimeConfigPath(filesRoot, kbId) {
    return path.join(ragKbDirPath(filesRoot, kbId), "runtime_config.json");
}
export function ragIndexMetaPath(filesRoot, kbId) {
    return path.join(ragKbDirPath(filesRoot, kbId), "index_meta.json");
}
export function ragEvalRunsDir(filesRoot, kbId) {
    return path.join(ragKbDirPath(filesRoot, kbId), "eval");
}

/** 将旧版 files/kb_{id}/rag/ 迁移到 files/rag_kb_{id}/ */
export function migrateLegacyRagKbData(filesRoot, ragKbStore) {
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
            ragKbStore.createKb(kbId, `RAG 知识库 ${kbId}`);
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
export const MODEL_ROUTER_ROOT = path.resolve(APP_ROOT, "..", "model_router");
export const DOCLING_SCRIPT = path.join(MODEL_ROUTER_ROOT, "scripts", "docling_extract_pages.py");
