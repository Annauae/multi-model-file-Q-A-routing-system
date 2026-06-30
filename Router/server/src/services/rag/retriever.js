import { charNgrams, msSince } from "./textUtils.js";
import { loadFaqItems, buildItemMap, itemToResult } from "./dataLoader.js";
import { readIndexMeta } from "./indexStatus.js";
import { kbAssetsDirPath, ragQuestionsJsonPath } from "../paths.js";

export class RagRetriever {
    settings;
    kbId;
    ragModelsStore;
    weaviateStore;
    embeddingClient;
    ragLlmClient;
    runtimeConfig;
    itemMap = null;

    constructor(kbId, ctx, runtimeConfig) {
        this.kbId = kbId;
        this.settings = ctx.settings;
        this.ragModelsStore = ctx.ragModelsStore;
        this.weaviateStore = ctx.weaviateStore;
        this.embeddingClient = ctx.embeddingClient;
        this.ragLlmClient = ctx.ragLlmClient;
        this.runtimeConfig = runtimeConfig;
    }

    rt(name, defaultVal) {
        if (this.runtimeConfig && this.runtimeConfig[name] != null)
            return this.runtimeConfig[name];
        return defaultVal;
    }

    loadItems() {
        if (this.itemMap)
            return this.itemMap;
        const filePath = ragQuestionsJsonPath(this.settings.filesRoot, this.kbId);
        const assetsDir = kbAssetsDirPath(this.settings.filesRoot, this.kbId);
        this.itemMap = buildItemMap(loadFaqItems(filePath, assetsDir));
        return this.itemMap;
    }

    async search(query, topK) {
        const top_k = topK ?? this.rt("top_k", 8);
        const timing = {};
        const tTotal = performance.now();

        const tEmb = performance.now();
        const qVec = await this.embeddingClient.embedQuery(query);
        timing.embedding_ms = msSince(tEmb);

        const tVec = performance.now();
        const vectorHits = await this.weaviateStore.hybridSearch(
            this.kbId, query, qVec, this.settings.ragVectorTopK, 0.75,
        );
        timing.vector_lookup_ms = msSince(tVec);

        const tKw = performance.now();
        const keywordHits = await this._keywordSearch(query, this.settings.ragKeywordTopK);
        timing.keyword_search_ms = msSince(tKw);

        const tFus = performance.now();
        const candidates = this._fuseAndGroup(vectorHits, keywordHits);
        timing.fusion_ms = msSince(tFus);

        let results;
        if (!this.rt("use_rerank", true)) {
            candidates.sort((a, b) => b.rrf_score - a.rrf_score);
            timing.rerank_ms = 0;
            results = candidates.slice(0, top_k).map((c) => this._candidateToResult(c));
        }
        else {
            const tRr = performance.now();
            const ranked = await this._rerank(query, candidates, Math.max(top_k, 8));
            timing.rerank_ms = msSince(tRr);
            results = ranked.slice(0, top_k).map((c) => this._candidateToResult(c));
        }

        timing.search_ms = msSince(tTotal);
        timing.total_ms = timing.search_ms;
        return { results, timing };
    }

    async chat(query, { topN, useLlmAnswer } = {}) {
        const tTotal = performance.now();
        const top_n = topN ?? this.rt("top_n", 3);
        const { results, timing } = await this.search(query, Math.max(top_n, 8));
        const minConf = this.rt("min_confidence_score", 0.05);
        const topScore = results.length
            ? Number(results[0].rerank_score || results[0].rrf_score || 0)
            : 0;
        const highConf = results.length > 0 && topScore >= minConf;

        if (!highConf) {
            timing.generate_ms = 0;
            timing.total_ms = msSince(tTotal);
            return {
                answer: "未找到高置信答案。你可以换一种问法，或查看下方候选结果。",
                confidence: 0,
                sources: results.slice(0, top_n),
                images: [],
                mode: "no_high_confidence",
                timing,
            };
        }

        const sources = results.slice(0, top_n);
        const rtMode = this.rt("answer_mode", "direct");
        const shouldGenerate = rtMode === "generated" || Boolean(useLlmAnswer);
        let answer;
        let mode;
        if (shouldGenerate) {
            const tGen = performance.now();
            answer = await this.ragLlmClient.generateAnswer(query, sources, this.runtimeConfig);
            timing.generate_ms = msSince(tGen);
            mode = "generated";
        }
        else {
            answer = sources[0].answer;
            timing.generate_ms = 0;
            mode = "direct";
        }

        timing.total_ms = msSince(tTotal);
        return {
            answer,
            confidence: topScore,
            sources,
            images: this._dedupeImages(sources),
            mode,
            timing,
        };
    }

    async _keywordSearch(query, limit) {
        const meta = readIndexMeta(this.settings.filesRoot, this.kbId);
        const index = meta?.keyword_index ?? [];
        const qTokens = [...new Set(charNgrams(query, 2, 3))].slice(0, 48);
        const scored = [];
        for (const row of index) {
            if (row.is_eval_holdout)
                continue;
            const text = String(row.keyword_text || "");
            let score = 0;
            for (const tok of qTokens) {
                if (tok && text.includes(tok))
                    score++;
            }
            if (score > 0) {
                scored.push({
                    doc_id: row.doc_id,
                    item_id: row.item_id,
                    doc_type: row.doc_type,
                    text: row.text,
                    keyword_text: row.keyword_text,
                    score,
                    rank_source: "keyword",
                });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        if (scored.length)
            return scored.slice(0, limit);

        const kwHits = await this.weaviateStore.hybridSearch(
            this.kbId, query, null, limit, 0,
        );
        return kwHits.map((h) => ({ ...h, rank_source: "keyword" }));
    }

    _fuseAndGroup(vectorHits, keywordHits) {
        const byItem = new Map();
        const rrfK = this.settings.ragRrfK;

        const add = (hit, rank, source) => {
            const itemId = String(hit.item_id);
            let cand = byItem.get(itemId);
            if (!cand) {
                cand = {
                    item_id: itemId,
                    vector_score: 0,
                    keyword_score: 0,
                    rrf_score: 0,
                    rerank_score: 0,
                    matched_doc_types: new Set(),
                    matched_doc_ids: [],
                };
                byItem.set(itemId, cand);
            }
            cand.rrf_score += 1 / (rrfK + rank);
            cand.matched_doc_types.add(String(hit.doc_type));
            const docId = String(hit.doc_id);
            if (!cand.matched_doc_ids.includes(docId))
                cand.matched_doc_ids.push(docId);
            const score = Number(hit.score || 0);
            if (source === "vector")
                cand.vector_score = Math.max(cand.vector_score, score);
            else
                cand.keyword_score = Math.max(cand.keyword_score, score);
        };

        vectorHits.forEach((h, i) => add(h, i + 1, "vector"));
        keywordHits.forEach((h, i) => add(h, i + 1, "keyword"));

        return [...byItem.values()].sort((a, b) => b.rrf_score - a.rrf_score);
    }

    async _rerank(query, candidates, topK) {
        const items = this.loadItems();
        const docs = [];
        const kept = [];
        for (const cand of candidates.slice(0, Math.max(topK * 3, topK))) {
            const item = items.get(cand.item_id);
            if (!item)
                continue;
            const variants = (item.variants || []).slice(0, 8).join("；");
            docs.push(`主问题：${item.question}\n相似问法：${variants}\n答案摘要：${item.answer_summary}`);
            kept.push(cand);
        }
        if (!kept.length)
            return [];
        const ranked = await this.ragLlmClient.rerank(query, docs, Math.min(topK, kept.length));
        const output = [];
        const used = new Set();
        for (const [idx, score] of ranked) {
            if (idx < 0 || idx >= kept.length || used.has(idx))
                continue;
            kept[idx].rerank_score = Number(score);
            output.push(kept[idx]);
            used.add(idx);
        }
        if (output.length < Math.min(topK, kept.length)) {
            for (let idx = 0; idx < kept.length; idx++) {
                if (!used.has(idx)) {
                    kept[idx].rerank_score = kept[idx].rrf_score;
                    output.push(kept[idx]);
                }
                if (output.length >= topK)
                    break;
            }
        }
        return output;
    }

    _candidateToResult(cand) {
        const items = this.loadItems();
        const item = items.get(cand.item_id);
        if (!item)
            return { id: cand.item_id };
        return itemToResult(item, {
            vector_score: cand.vector_score,
            keyword_score: cand.keyword_score,
            rrf_score: cand.rrf_score,
            rerank_score: cand.rerank_score,
            matched_doc_types: [...cand.matched_doc_types].sort(),
            matched_doc_ids: cand.matched_doc_ids,
        });
    }

    _dedupeImages(sources) {
        const seen = new Set();
        const images = [];
        for (const src of sources) {
            for (const img of src.images || []) {
                const key = img.src || img.url || "";
                if (key && !seen.has(key)) {
                    seen.add(key);
                    images.push(img);
                }
            }
        }
        return images;
    }
}
