import * as recallRepo from "../repositories/recallTestsRepo.js";

export class RagRecallTestsStore {
    kbType;
    kbId;

    constructor(kbType, kbId) {
        this.kbType = kbType;
        this.kbId = kbId;
    }

    static open(kbId) {
        return new RagRecallTestsStore("rag", kbId);
    }

    static openLlm(kbId) {
        return new RagRecallTestsStore("llm", kbId);
    }

    async getDocument() {
        return recallRepo.getRecallTests(this.kbType, this.kbId);
    }

    async replaceAll(body) {
        return recallRepo.replaceRecallTests(this.kbType, this.kbId, body);
    }
}
