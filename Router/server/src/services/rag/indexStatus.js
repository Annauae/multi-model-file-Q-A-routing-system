import * as ragMetaRepo from "../../db/repositories/ragMetaRepo.js";
import * as kbRepo from "../../db/repositories/kbRepo.js";
import * as qaRepo from "../../db/repositories/qaRepo.js";
import { dataHashFromContent } from "./dataLoader.js";

export async function readIndexMeta(_filesRoot, kbId) {
    return ragMetaRepo.getIndexMeta(kbId);
}

export async function writeIndexMeta(_filesRoot, kbId, meta) {
    await ragMetaRepo.saveIndexMeta(kbId, meta);
}

export async function indexStatus(settings, kbId, ragModelsStore) {
    const doc = await qaRepo.getDocument("rag", kbId);
    if (!doc.items.length) {
        const hasKb = await kbRepo.getRagKb(kbId);
        if (!hasKb)
            return { ready: false, stale: true, reason: "RAG FAQ 不存在" };
    }
    const meta = await readIndexMeta(settings.filesRoot, kbId);
    if (!meta?.built_at)
        return { ready: false, stale: true, reason: "索引不存在" };
    let currentHash;
    try {
        currentHash = dataHashFromContent(JSON.stringify({ version: doc.version, items: doc.items }));
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
