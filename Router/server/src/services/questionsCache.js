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

    buildIndex(docItems, confidenceMatchPrompt, topK) {
        const itemsById = new Map();
        const enabledItems = [];
        const validIds = new Set();
        for (const item of docItems) {
            itemsById.set(item.id, item);
            if (item.enabled) {
                enabledItems.push(item);
                validIds.add(item.id);
            }
        }
        return {
            itemsById,
            enabledItems,
            validIds,
            confidenceSystemPrompt: buildConfidenceSystemPrompt(confidenceMatchPrompt, enabledItems, topK),
            loadedAt: nowIso(),
            sourceMtime: 0,
        };
    }

    async loadKb(kbId) {
        if (!this.kbStore.get(kbId))
            throw new Error("kb_id 不存在");
        const store = this.storeFor(kbId);
        const doc = await store.getDocument();
        const idx = this.buildIndex(doc.items, this.confidencePrompt(), this.confidenceTopK);
        idx.sourceMtime = store.sourceMtime;
        this.indexes.set(kbId, idx);
        return idx;
    }

    async reloadKb(kbId) {
        this.stores.delete(kbId);
        return this.loadKb(kbId);
    }

    evictKb(kbId) {
        this.indexes.delete(kbId);
        this.stores.delete(kbId);
    }

    async loadAll() {
        for (const kbId of Object.keys(this.kbStore.getAll())) {
            try {
                await this.loadKb(kbId);
            }
            catch {
                /* skip broken kb */
            }
        }
    }

    async reloadAll() {
        for (const kbId of Object.keys(this.kbStore.getAll())) {
            try {
                await this.reloadKb(kbId);
            }
            catch {
                /* skip */
            }
        }
    }

    getIndex(kbId) {
        return this.indexes.get(kbId);
    }

    async getConfidenceSystemPrompt(kbId, topK) {
        let idx = this.getIndex(kbId);
        if (!idx)
            idx = await this.loadKb(kbId);
        if (topK == null || topK === this.confidenceTopK)
            return idx.confidenceSystemPrompt;
        return buildConfidenceSystemPrompt(this.confidencePrompt(), idx.enabledItems, topK);
    }

    async getEnabledCount(kbId) {
        let idx = this.getIndex(kbId);
        if (!idx)
            idx = await this.loadKb(kbId);
        return idx.enabledItems.length;
    }

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
