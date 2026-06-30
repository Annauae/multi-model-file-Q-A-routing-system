import path from "node:path";
import { APP_ROOT } from "../config.js";
export const DOCUMENTS_FOLDER = "documents";
export function kbFolderName(kbId) {
    return `kb_${kbId}`;
}
export function kbDirPath(filesRoot, kbId) {
    return path.join(filesRoot, kbFolderName(kbId));
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
