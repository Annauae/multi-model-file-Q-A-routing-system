import { charNgrams, msSince, clipText } from "./textUtils.js";
import { loadFaqItemsFromRows, buildItemMap, itemToResult } from "./dataLoader.js";
import { readIndexMeta } from "./indexStatus.js";
import { ragKbAssetsDirPath } from "../paths.js";
import { SEARCHABLE_DOC_TYPES } from "./searchDocBuilder.js";
import { aggregateTokens } from "./tokenUtils.js";
import { RagLogSink, formatRagSearchSummary } from "./ragLogger.js";

/**
 * RAG 检索器 — 向量 + 关键词混合检索、RRF 融合、rerank、chat 直出/合成。
 * 调试页 POST /rag/chat 的核心执行类。
 */
export class RagRetriever {
    settings;
    kbId;
    ragModelsStore;
    weaviateStore;
    embeddingClient;
    ragLlmClient;
    runtimeConfig;
    itemMap = null;
    log;
    ragCtx;

    constructor(kbId, ctx, runtimeConfig, logModule = "rag-debug") {
        this.kbId = kbId;
        this.ragCtx = ctx;
        this.settings = ctx.settings;
        this.ragModelsStore = ctx.ragModelsStore;
        this.weaviateStore = ctx.weaviateStore;
        this.embeddingClient = ctx.embeddingClient;
        this.ragLlmClient = ctx.ragLlmClient;
        this.runtimeConfig = runtimeConfig;
        this.log = new RagLogSink(ctx.opLog, logModule, kbId);
    }

    rt(name, defaultVal) {
        if (this.runtimeConfig && this.runtimeConfig[name] != null)
            return this.runtimeConfig[name];
        return defaultVal;
    }

    async loadItems() {
        if (this.itemMap)
            return this.itemMap;
        const store = this.ragCtx.getRagQuestionsStore(this.kbId);
        const doc = await store.getDocument();
        const assetsDir = ragKbAssetsDirPath(this.settings.filesRoot, this.kbId);
        this.itemMap = buildItemMap(loadFaqItemsFromRows(doc.items, assetsDir));
        return this.itemMap;
    }

    /**
     * 混合检索：embed query → Weaviate 向量检索 → 关键词 n-gram → RRF 融合 → rerank。
     * 例：query="怎么调光圈" 可能命中 q012 光圈调节相关 FAQ。
     */
    async search(query, topK) {
        const top_k = topK ?? this.rt("top_k", 8);
        const timing = {};
        const tTotal = performance.now();
        this.log.log(`[search] 开始 query="${clipText(query, 120)}" top_k=${top_k} use_rerank=${this.rt("use_rerank", true)}`, "step", "search");

        const tEmb = performance.now();
        const { vector: qVec, usage: embUsage } = await this.embeddingClient.embedQuery(query);
        timing.embedding_ms = msSince(tEmb);
        this.log.timing("embedding", timing.embedding_ms);
        if (embUsage)
            this.log.log(`[search] embedding tokens prompt=${embUsage.prompt_tokens ?? 0} total=${embUsage.total_tokens ?? 0}`, "step", "embedding");
        const tokenBreakdown = [];
        if (embUsage)
            tokenBreakdown.push({ phase: "embedding", usage: embUsage });

        const tVec = performance.now();
        const vectorHits = this._filterSearchHits(await this.weaviateStore.hybridSearch(
            this.kbId, query, qVec, this.settings.ragVectorTopK, 0.75,
        ));
        timing.vector_lookup_ms = msSince(tVec);
        this.log.log(`[search] 向量检索 ${vectorHits.length} 条 (top ${this.settings.ragVectorTopK})`, "step", "vector");
        if (vectorHits.length)
            this.log.log(`[search] 向量 Top3: ${vectorHits.slice(0, 3).map((h, i) => `#${i + 1} ${h.item_id} score=${Number(h.score || 0).toFixed(3)}`).join(" | ")}`, "step", "vector-top");

        const tKw = performance.now();
        const keywordHits = this._filterSearchHits(await this._keywordSearch(query, this.settings.ragKeywordTopK));
        timing.keyword_search_ms = msSince(tKw);
        this.log.log(`[search] 关键词检索 ${keywordHits.length} 条`, "step", "keyword");
        if (keywordHits.length)
            this.log.log(`[search] 关键词 Top3: ${keywordHits.slice(0, 3).map((h, i) => `#${i + 1} ${h.item_id} score=${Number(h.score || 0).toFixed(3)}`).join(" | ")}`, "step", "keyword-top");

        const tFus = performance.now();
        const candidates = this._fuseAndGroup(vectorHits, keywordHits);
        timing.fusion_ms = msSince(tFus);
        this.log.log(`[search] RRF 融合 ${candidates.length} 候选 (rrf_k=${this.settings.ragRrfK})`, "step", "fusion");
        if (candidates.length)
            this.log.log(`[search] 融合 Top3: ${candidates.slice(0, 3).map((c, i) => `#${i + 1} ${c.item_id} rrf=${c.rrf_score.toFixed(4)} vec=${c.vector_score.toFixed(3)} kw=${c.keyword_score.toFixed(3)}`).join(" | ")}`, "step", "fusion-top");

        let results;
        if (!this.rt("use_rerank", true)) {
            candidates.sort((a, b) => b.rrf_score - a.rrf_score);
            timing.rerank_ms = 0;
            results = await Promise.all(candidates.slice(0, top_k).map((c) => this._candidateToResult(c)));
            this.log.log("[search] rerank 已关闭，按 RRF 排序", "step", "rerank-skip");
        }
        else {
            const tRr = performance.now();
            const { output, usage: rerankUsage } = await this._rerank(query, candidates, Math.max(top_k, 8));
            timing.rerank_ms = msSince(tRr);
            results = await Promise.all(output.slice(0, top_k).map((c) => this._candidateToResult(c)));
            this.log.timing("rerank", timing.rerank_ms);
            this.log.log(`[search] rerank 完成，返回 ${results.length} 条`, "step", "rerank");
            if (rerankUsage)
                tokenBreakdown.push({ phase: "rerank", usage: rerankUsage });
        }

        timing.search_ms = msSince(tTotal);
        timing.total_ms = timing.search_ms;
        const { tokens, token_breakdown } = aggregateTokens(tokenBreakdown);
        this.log.timing("search_total", timing.search_ms);
        this.log.log(`[search] 完成 ${formatRagSearchSummary(results)}`, "result", "search-done");
        return { results, timing, tokens, token_breakdown };
    }

    /**
     * RAG 问答主流程：先 search，再按置信度与 answer_mode 决定返回方式。
     * - no_high_confidence：Top1 分数 < min_confidence_score
     * - direct：直出 Top1 的 answer（默认）
     * - generated：用 RAG LLM 根据 sources 合成回答
     */
    async chat(query, { topN, useLlmAnswer } = {}) {
        const tTotal = performance.now();
        const top_n = topN ?? this.rt("top_n", 3);
        const rtMode = this.rt("answer_mode", "direct");
        const minConf = this.rt("min_confidence_score", 0.05);
        this.log.log(`[chat] 开始 query="${clipText(query, 120)}" top_n=${top_n} answer_mode=${rtMode} min_confidence=${minConf}`, "step", "chat");

        const { results, timing, token_breakdown: searchBreakdown } = await this.search(query, Math.max(top_n, 8));
        const tokenBreakdown = [...(searchBreakdown || [])];
        const topScore = results.length
            ? Number(results[0].rerank_score || results[0].rrf_score || 0)
            : 0;
        const highConf = results.length > 0 && topScore >= minConf;
        this.log.log(`[chat] 置信判定 top_score=${topScore.toFixed(4)} min=${minConf} high_conf=${highConf}`, "step", "confidence");

        if (!highConf) {
            timing.generate_ms = 0;
            timing.total_ms = msSince(tTotal);
            const { tokens, token_breakdown } = aggregateTokens(tokenBreakdown);
            this.log.log("[chat] 未达置信阈值，返回低置信提示", "result", "chat-low-conf");
            return {
                answer: "未找到高置信答案。你可以换一种问法，或查看下方候选结果。",
                confidence: 0,
                sources: results.slice(0, top_n),
                images: [],
                mode: "no_high_confidence",
                timing,
                tokens,
                token_breakdown,
            };
        }

        const sources = results.slice(0, top_n);
        const shouldGenerate = rtMode === "generated" || Boolean(useLlmAnswer);
        let answer;
        let mode;
        if (shouldGenerate) {
            const tGen = performance.now();
            this.log.log(`[chat] LLM 合成回答，来源 ${sources.length} 条: ${sources.map((s) => s.id).join(", ")}`, "step", "generate");
            const gen = await this.ragLlmClient.generateAnswer(query, sources, this.runtimeConfig);
            answer = gen.content;
            if (gen.usage) {
                tokenBreakdown.push({ phase: "generate", usage: gen.usage });
                this.log.log(`[chat] 生成 tokens prompt=${gen.usage.prompt_tokens ?? 0} completion=${gen.usage.completion_tokens ?? 0}`, "step", "generate-tokens");
            }
            timing.generate_ms = msSince(tGen);
            mode = "generated";
            this.log.timing("generate", timing.generate_ms);
            this.log.log(`[chat] 合成回答 ${clipText(answer, 200)}`, "step", "generate-done");
        }
        else {
            answer = sources[0].answer;
            timing.generate_ms = 0;
            mode = "direct";
            this.log.log(`[chat] 直出模式 top1=${sources[0]?.id} answer_len=${(answer || "").length}`, "step", "direct");
        }

        timing.total_ms = msSince(tTotal);
        const { tokens, token_breakdown } = aggregateTokens(tokenBreakdown);
        this.log.timing("chat_total", timing.total_ms);
        this.log.log(`[chat] 完成 mode=${mode} confidence=${topScore.toFixed(4)} sources=${sources.length}`, "result", "chat-done");
        return {
            answer,
            confidence: topScore,
            sources,
            images: this._dedupeImages(sources),
            mode,
            timing,
            tokens,
            token_breakdown,
        };
    }

    async _keywordSearch(query, limit) {
        const meta = await readIndexMeta(this.settings.filesRoot, this.kbId);
        const index = meta?.keyword_index ?? [];
        const qTokens = [...new Set(charNgrams(query, 2, 3))].slice(0, 48);
        const scored = [];
        for (const row of index) {
            if (row.is_eval_holdout)
                continue;
            if (!SEARCHABLE_DOC_TYPES.has(String(row.doc_type || "")))
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

    _filterSearchHits(hits) {
        return hits.filter((h) => SEARCHABLE_DOC_TYPES.has(String(h.doc_type || "")));
    }

    async _rerank(query, candidates, topK) {
        const items = await this.loadItems();
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
            return { output: [], usage: null };
        const { ranked, usage } = await this.ragLlmClient.rerank(query, docs, Math.min(topK, kept.length));
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
        return { output, usage };
    }

    async _candidateToResult(cand) {
        const items = await this.loadItems();
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
