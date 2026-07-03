/**
 * questionsCache.js — LLM 知识库 FAQ 内存索引
 *
 * 服务启动时 createAppContext() 调用 loadAll()，把所有 LLM 库的 FAQ 载入内存。
 * runConfidenceMatch 优先读内存，避免每次提问都查 PostgreSQL。
 *
 * 每个 kbId 的索引含：
 *   itemsById, enabledItems, validIds, confidenceSystemPrompt, loadedAt
 */

import { buildConfidenceSystemPrompt } from "../services/matcher.js";
import { QuestionsStore } from "../db/stores/questionsStore.js";

function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class QuestionsCache {
    kbStore;
    confidenceTopK;
    promptsStore;
    indexes = new Map();
    stores = new Map();

    constructor(kbStore, confidenceTopK = 5, promptsStore) {
        this.kbStore = kbStore;
        this.confidenceTopK = confidenceTopK;
        this.promptsStore = promptsStore;
    }

    confidencePrompt() {
        return this.promptsStore?.get().confidence_match_prompt ?? "";
    }

    storeFor(kbId) {
        if (!this.stores.has(kbId)) {
            this.stores.set(kbId, QuestionsStore.open("llm", kbId, (changed) => {
                void this.reloadKb(changed);
            }));
        }
        return this.stores.get(kbId);
    }

    buildIndex(docItems, confidenceMatchPrompt, topK) { /** 构建内存索引 */
        const itemsById = new Map(); // 存储 FAQ 项的 Map，键为 item.id，值为 item
        const enabledItems = []; // 存储启用项的数组
        const validIds = new Set(); // 存储有效项的 Set，键为 item.id
        for (const item of docItems) {
            itemsById.set(item.id, item); // 将 FAQ 项添加到 Map 中
            if (item.enabled) {
                enabledItems.push(item);
                validIds.add(item.id);
            }
        }
        return {
            itemsById,
            enabledItems,
            validIds,
            confidenceSystemPrompt: buildConfidenceSystemPrompt(confidenceMatchPrompt, enabledItems, topK), // 构建置信度系统提示词
            loadedAt: nowIso(), // 更新索引的加载时间
            sourceMtime: 0,
        };
    }

    async loadKb(kbId) { /** 从 PostgreSQL qa_items（kb_type='llm'）加载 FAQ，构建内存索引并缓存 */
        if (!this.kbStore.get(kbId))
            throw new Error("kb_id 不存在");
        const store = this.storeFor(kbId);
        const doc = await store.getDocument(); // 获取知识库的 FAQ 列表
        const idx = this.buildIndex(doc.items, this.confidencePrompt(), this.confidenceTopK); // 构建内存索引
        idx.sourceMtime = store.sourceMtime; // 更新索引的源文件修改时间
        this.indexes.set(kbId, idx);
        return idx; // 返回内存索引
    }

    async reloadKb(kbId) {
        this.stores.delete(kbId);
        return this.loadKb(kbId);
    }

    evictKb(kbId) {
        this.indexes.delete(kbId);
        this.stores.delete(kbId);
    }

    async loadAll() { /** 加载所有知识库的 FAQ 索引 */
        for (const kbId of Object.keys(this.kbStore.getAll())) {
            try {
                await this.loadKb(kbId);
            }
            catch {
                /* skip broken kb */
            }
        }
    }

    async reloadAll() { /** 重新加载所有知识库的 FAQ 索引 */
        for (const kbId of Object.keys(this.kbStore.getAll())) {
            try {
                await this.reloadKb(kbId);
            }
            catch {
                /* skip */
            }
        }
    }

    getIndex(kbId) { /** 获取知识库的 FAQ 索引 */
        return this.indexes.get(kbId);
    }

    async getConfidenceSystemPrompt(kbId, topK) { /** 获取知识库的 FAQ 索引的置信度系统提示词 */
        let idx = this.getIndex(kbId);
        if (!idx)
            idx = await this.loadKb(kbId);
        if (topK == null || topK === this.confidenceTopK)
            return idx.confidenceSystemPrompt;
        return buildConfidenceSystemPrompt(this.confidencePrompt(), idx.enabledItems, topK);
    }

    async getEnabledCount(kbId) { /** 获取知识库的 FAQ 索引的启用项数量 */
        let idx = this.getIndex(kbId);
        if (!idx)
            idx = await this.loadKb(kbId);
        return idx.enabledItems.length;
    }

    /** 按 LLM 匹配结果中的 item id（如 q003）取完整 FAQ 项（含 answer Markdown） */
    resolveItem(kbId, matchedId) {
        const idx = this.getIndex(kbId);
        if (!idx)
            return null;
        const item = idx.itemsById.get(matchedId);
        if (!item || !item.enabled)
            return null;
        return item;
    }

    store(kbId) {
        return this.storeFor(kbId);
    }

    async previewConfidenceSystemPrompt(kbId, topK = 5) {
        if (!this.kbStore.get(kbId))
            throw new Error("kb_id 不存在");
        const confPrompt = this.confidencePrompt();
        const systemPrompt = await this.getConfidenceSystemPrompt(kbId, topK);
        return [confPrompt, systemPrompt, await this.getEnabledCount(kbId)];
    }
}
