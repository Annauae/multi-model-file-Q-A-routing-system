import { buildConfidenceSystemPrompt } from "./matcher.js";
import { questionsJsonPath } from "./paths.js";
import { QuestionsStore } from "./questionsStore.js";
function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
export class QuestionsCache {
    kbStore;
    filesRoot;
    confidenceTopK;
    promptsStore;
    indexes = new Map();
    stores = new Map();
    constructor(kbStore, filesRoot, confidenceTopK = 5, promptsStore) {
        this.kbStore = kbStore;
        this.filesRoot = filesRoot;
        this.confidenceTopK = confidenceTopK;
        this.promptsStore = promptsStore;
    }
    confidencePrompt() {
        return this.promptsStore?.get().confidence_match_prompt ?? "";
    }
    storeFor(kbId) {
        if (!this.stores.has(kbId)) {
            const p = questionsJsonPath(this.filesRoot, kbId);
            this.stores.set(kbId, QuestionsStore.open(p, kbId, (changed) => this.reloadKb(changed)));
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
    loadKb(kbId) {
        if (!this.kbStore.get(kbId))
            throw new Error("kb_id 不存在");
        const store = this.storeFor(kbId);
        const doc = store.getDocument();
        const idx = this.buildIndex(doc.items, this.confidencePrompt(), this.confidenceTopK);
        idx.sourceMtime = store.sourceMtime;
        this.indexes.set(kbId, idx);
        return idx;
    }
    reloadKb(kbId) {
        this.stores.delete(kbId);
        return this.loadKb(kbId);
    }
    evictKb(kbId) {
        this.indexes.delete(kbId);
        this.stores.delete(kbId);
    }
    loadAll() {
        for (const kbId of Object.keys(this.kbStore.getAll())) {
            try {
                this.loadKb(kbId);
            }
            catch {
                /* skip broken kb */
            }
        }
    }
    reloadAll() {
        for (const kbId of Object.keys(this.kbStore.getAll())) {
            try {
                this.reloadKb(kbId);
            }
            catch {
                /* skip */
            }
        }
    }
    getIndex(kbId) {
        return this.indexes.get(kbId);
    }
    getConfidenceSystemPrompt(kbId, topK) {
        let idx = this.getIndex(kbId);
        if (!idx)
            idx = this.loadKb(kbId);
        if (topK == null || topK === this.confidenceTopK)
            return idx.confidenceSystemPrompt;
        return buildConfidenceSystemPrompt(this.confidencePrompt(), idx.enabledItems, topK);
    }
    getEnabledCount(kbId) {
        let idx = this.getIndex(kbId);
        if (!idx)
            idx = this.loadKb(kbId);
        return idx.enabledItems.length;
    }
    resolveItem(kbId, matchedId) {
        let idx = this.getIndex(kbId);
        if (!idx)
            idx = this.loadKb(kbId);
        const item = idx.itemsById.get(matchedId);
        if (!item || !item.enabled)
            return null;
        return item;
    }
    store(kbId) {
        return this.storeFor(kbId);
    }
    previewConfidenceSystemPrompt(kbId, topK = 5) {
        if (!this.kbStore.get(kbId))
            throw new Error("kb_id 不存在");
        const confPrompt = this.confidencePrompt();
        const systemPrompt = this.getConfidenceSystemPrompt(kbId, topK);
        return [confPrompt, systemPrompt, this.getEnabledCount(kbId)];
    }
}
