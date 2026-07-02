import { loadFaqItems, dataHashFromFile } from "./dataLoader.js";
import { buildAllSearchDocs } from "./searchDocBuilder.js";
import { writeIndexMeta, readIndexMeta } from "./indexStatus.js";
import { ragQuestionsJsonPath, ragKbAssetsDirPath } from "../paths.js";

export async function rebuildIndex(kbId, ctx) {
    const { settings, ragModelsStore, weaviateStore } = ctx;
    const filePath = ragQuestionsJsonPath(settings.filesRoot, kbId);
    const assetsDir = ragKbAssetsDirPath(settings.filesRoot, kbId);
    const items = loadFaqItems(filePath, assetsDir);
    const holdoutPerItem = settings.ragEvalHoldoutPerItem;
    const { allDocs, indexedDocs, holdoutVariantsByItem } = buildAllSearchDocs(items, holdoutPerItem);

    const embedder = ctx.embeddingClient;
    const texts = indexedDocs.map((d) => d.text);
    console.log(`[rag/index] kb=${kbId} embedding ${texts.length} docs…`);
    const { vectors } = texts.length ? await embedder.embedTexts(texts) : { vectors: [] };

    await weaviateStore.deleteByKbId(kbId);
    const rows = indexedDocs.map((doc, i) => ({
        ...doc,
        vector: vectors[i] ?? [],
    }));
    await weaviateStore.upsertBatch(kbId, rows);

    const embedCfg = ragModelsStore.getSlot("embedding");
    const backend = embedder.useApi ? embedCfg.model : "hash-fallback";
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const keywordIndex = allDocs.map((d) => ({
        doc_id: d.doc_id,
        item_id: d.item_id,
        doc_type: d.doc_type,
        keyword_text: d.keyword_text,
        text: d.text,
        is_eval_holdout: d.is_eval_holdout,
    }));

    const meta = {
        data_hash: dataHashFromFile(filePath),
        embedding_model: backend,
        embedding_dim: String(vectors[0]?.length ?? 0),
        built_at: now,
        items: String(items.length),
        search_docs: String(indexedDocs.length),
        holdout_docs: String(allDocs.length - indexedDocs.length),
        keyword_index: keywordIndex,
        holdout_variants: Object.fromEntries(
            [...holdoutVariantsByItem.entries()].map(([id, set]) => [id, [...set]]),
        ),
    };
    writeIndexMeta(settings.filesRoot, kbId, meta);
    console.log(`[rag/index] kb=${kbId} done: ${indexedDocs.length} docs`);
    return meta;
}

export function markIndexStale(settings, kbId) {
    const meta = readIndexMeta(settings.filesRoot, kbId);
    if (!meta)
        return;
    meta.stale_flag = true;
    writeIndexMeta(settings.filesRoot, kbId, meta);
}
