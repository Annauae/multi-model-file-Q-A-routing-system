import { RagKbStore } from "../db/stores/ragKbStore.js";
import { RagModelsStore } from "../db/stores/ragModelsStore.js";
import { RagPromptsStore } from "../db/stores/ragPromptsStore.js";
import { RagQuestionsStore } from "../db/stores/questionsStore.js";
import { RagRecallTestsStore } from "../db/stores/ragRecallTestsStore.js";
import { RagRuntimeConfigStore } from "../db/stores/ragRuntimeConfigStore.js";
import { EmbeddingClient } from "./rag/embeddingClient.js";
import { RagLlmClient } from "./rag/ragLlmClient.js";
import { createWeaviateStore } from "./rag/weaviateStore.js";
import { migrateLegacyRagKbData } from "./paths.js";
import { markIndexStale } from "./rag/indexer.js";

export async function createRagContext(baseCtx) {
    const { settings, opLog } = baseCtx;
    const ragKbStore = new RagKbStore();
    await ragKbStore.init();
    await migrateLegacyRagKbData(settings.filesRoot, ragKbStore);

    const ragModelsStore = RagModelsStore.fromSettings(settings);
    await ragModelsStore.init();
    const ragPromptsStore = RagPromptsStore.open();
    await ragPromptsStore.init();
    const weaviateStore = createWeaviateStore(settings);
    const embeddingClient = new EmbeddingClient(settings, ragModelsStore);
    const ragLlmClient = new RagLlmClient(ragModelsStore, ragPromptsStore);

    const ragQuestionStores = new Map();
    const onRagChange = (kbId) => {
        void markIndexStale(settings, kbId);
    };

    function getRagQuestionsStore(kbId) {
        if (!ragQuestionStores.has(kbId)) {
            ragQuestionStores.set(kbId, RagQuestionsStore.open(kbId, onRagChange));
        }
        return ragQuestionStores.get(kbId);
    }

    async function getRuntimeConfig(kbId) {
        return RagRuntimeConfigStore.open(kbId).load();
    }

    async function updateRuntimeConfig(kbId, patch) {
        return RagRuntimeConfigStore.open(kbId).update(patch);
    }

    function getRecallTestsStore(kbId) {
        return RagRecallTestsStore.open(kbId);
    }

    function getLlmRecallTestsStore(kbId) {
        return RagRecallTestsStore.openLlm(kbId);
    }

    return {
        settings,
        opLog,
        ragKbStore,
        ragModelsStore,
        ragPromptsStore,
        weaviateStore,
        embeddingClient,
        ragLlmClient,
        getRagQuestionsStore,
        getRuntimeConfig,
        updateRuntimeConfig,
        getRecallTestsStore,
        getLlmRecallTestsStore,
    };
}
