import { stableHash, keywordText } from "./textUtils.js";

export function holdoutVariants(item, count) {
    if (count <= 0 || !item.variants?.length)
        return new Set();
    const ranked = [...item.variants].sort((a, b) => stableHash(`${item.id}:${a}`).localeCompare(stableHash(`${item.id}:${b}`)));
    return new Set(ranked.slice(0, Math.min(count, ranked.length)));
}

export function buildSearchDocs(item, holdouts) {
    const docs = [];
    const questionText = `问题：${item.question}\n答案摘要：${item.answer_summary}`;
    docs.push({
        doc_id: `${item.id}::question`,
        item_id: item.id,
        doc_type: "question",
        text: questionText,
        keyword_text: keywordText([item.question, item.answer_summary]),
        is_eval_holdout: false,
    });
    for (let idx = 0; idx < item.variants.length; idx++) {
        const variant = item.variants[idx];
        const isHoldout = holdouts.has(variant);
        docs.push({
            doc_id: `${item.id}::variant::${idx}`,
            item_id: item.id,
            doc_type: "variant",
            text: `相似问法：${variant}\n主问题：${item.question}\n答案摘要：${item.answer_summary}`,
            keyword_text: keywordText([variant, item.question, item.answer_summary]),
            is_eval_holdout: isHoldout,
        });
    }
    docs.push({
        doc_id: `${item.id}::answer_summary`,
        item_id: item.id,
        doc_type: "answer_summary",
        text: `主问题：${item.question}\n答案摘要：${item.answer_summary}`,
        keyword_text: keywordText([item.question, item.answer_summary]),
        is_eval_holdout: false,
    });
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
