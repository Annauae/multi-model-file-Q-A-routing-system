import * as qaRepo from "../repositories/qaRepo.js";

export class QuestionsStore {
    kbType;
    kbId;
    onChange;
    lastLoadedAt = 0;

    constructor(kbType, kbId, onChange) {
        this.kbType = kbType;
        this.kbId = kbId;
        this.onChange = onChange;
    }

    static open(kbType, kbId, onChange) {
        return new QuestionsStore(kbType, kbId, onChange);
    }

    async getDocument() {
        const doc = await qaRepo.getDocument(this.kbType, this.kbId);
        this.lastLoadedAt = Date.now();
        return doc;
    }

    async replaceAll(version, items) {
        const doc = await qaRepo.replaceAll(this.kbType, this.kbId, version, items);
        this.lastLoadedAt = Date.now();
        this.onChange?.(this.kbId);
        return doc;
    }

    async getItem(itemId) {
        return qaRepo.getItem(this.kbType, this.kbId, itemId);
    }

    async upsertItem(item) {
        const result = await qaRepo.upsertItem(this.kbType, this.kbId, item);
        this.lastLoadedAt = Date.now();
        this.onChange?.(this.kbId);
        return result;
    }

    async deleteItem(itemId) {
        const result = await qaRepo.deleteItem(this.kbType, this.kbId, itemId);
        this.lastLoadedAt = Date.now();
        this.onChange?.(this.kbId);
        return result;
    }

    get sourceMtime() {
        return this.lastLoadedAt;
    }
}

export class RagQuestionsStore extends QuestionsStore {
    static open(kbId, onChange) {
        return new RagQuestionsStore("rag", kbId, onChange);
    }

    constructor(kbType, kbId, onChange) {
        super("rag", kbId, onChange);
    }
}
