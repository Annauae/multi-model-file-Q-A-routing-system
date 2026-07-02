import { stableHash, keywordText } from "./textUtils.js";

/** 参与向量/BM25 检索的文档类型（不含答案摘要） */
export const SEARCHABLE_DOC_TYPES = new Set(["question", "variant"]);

export function holdoutVariants(item, count) {
    if (count <= 0 || !item.variants?.length)
        return new Set();
    const ranked = [...item.variants].sort((a, b) => stableHash(`${item.id}:${a}`).localeCompare(stableHash(`${item.id}:${b}`)));
    return new Set(ranked.slice(0, Math.min(count, ranked.length)));
}

export function buildSearchDocs(item, holdouts) {
    const docs = [];
    docs.push({
        doc_id: `${item.id}::question`,
        item_id: item.id,
        doc_type: "question",
        text: item.question,
        keyword_text: keywordText([item.question]),
        is_eval_holdout: false,
    });
    for (let idx = 0; idx < item.variants.length; idx++) {
        const variant = item.variants[idx];
        const isHoldout = holdouts.has(variant);
        docs.push({
            doc_id: `${item.id}::variant::${idx}`,
            item_id: item.id,
            doc_type: "variant",
            text: variant,
            keyword_text: keywordText([variant, item.question]),
            is_eval_holdout: isHoldout,
        });
    }
    return docs;
}

export function buildAllSearchDocs(items, holdoutPerItem) {
    const allDocs = [];
    const indexedDocs = [];
    const holdoutVariantsByItem = new Map();
    for (const item of items) {
        const holdouts = holdoutVariants(item, holdoutPerItem);
        holdoutVariantsByItem.set(item.id, holdouts);
        const docs = buildSearchDocs(item, holdouts);
        allDocs.push(...docs);
        indexedDocs.push(...docs.filter((doc) => !doc.is_eval_holdout));
    }
    return { allDocs, indexedDocs, holdoutVariantsByItem };
}
