import fs from "node:fs";
import path from "node:path";
import { dataHashFromFile } from "./dataLoader.js";
import { ragIndexMetaPath, ragQuestionsJsonPath } from "../paths.js";

export function readIndexMeta(filesRoot, kbId) {
    const p = ragIndexMetaPath(filesRoot, kbId);
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    catch {
        return null;
    }
}

export function writeIndexMeta(filesRoot, kbId, meta) {
    const p = ragIndexMetaPath(filesRoot, kbId);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(meta, null, 2), "utf-8");
}

export function indexStatus(settings, kbId, ragModelsStore) {
    const qPath = ragQuestionsJsonPath(settings.filesRoot, kbId);
    if (!fs.existsSync(qPath))
        return { ready: false, stale: true, reason: "RAG FAQ 不存在" };
    const meta = readIndexMeta(settings.filesRoot, kbId);
    if (!meta?.built_at)
        return { ready: false, stale: true, reason: "索引不存在" };
    let currentHash;
    try {
        currentHash = dataHashFromFile(qPath);
    }
    catch {
        return { ready: false, stale: true, reason: "RAG FAQ 读取失败" };
    }
    const embedCfg = ragModelsStore.getSlot("embedding");
    const embedModel = embedCfg.api_key?.trim() ? embedCfg.model : "hash-fallback";
    const stale = meta.data_hash !== currentHash || (meta.embedding_model && meta.embedding_model !== embedModel);
    return {
        ready: true,
        stale,
        meta,
        reason: stale ? "索引过期" : "",
    };
}
