import { RagModelsStore } from "./ragModelsStore.js";
import { RagQuestionsStore } from "./ragQuestionsStore.js";
import { RagRecallTestsStore } from "./ragRecallTestsStore.js";
import { RagRuntimeConfigStore } from "./ragRuntimeConfigStore.js";
import { EmbeddingClient } from "./rag/embeddingClient.js";
import { RagLlmClient } from "./rag/ragLlmClient.js";
import { createWeaviateStore } from "./rag/weaviateStore.js";
import {
    ragQuestionsJsonPath,
    ragRecallTestsJsonPath,
    ragRuntimeConfigPath,
} from "./paths.js";
import { markIndexStale } from "./rag/indexer.js";

export function createRagContext(baseCtx) {
    const { settings, kbStore, opLog } = baseCtx;
    const ragModelsStore = RagModelsStore.fromSettings(settings);
    const weaviateStore = createWeaviateStore(settings);
    const embeddingClient = new EmbeddingClient(settings, ragModelsStore);
    const ragLlmClient = new RagLlmClient(ragModelsStore);

    const ragQuestionStores = new Map();
    const onRagChange = (kbId) => {
        markIndexStale(settings, kbId);
    };

    function getRagQuestionsStore(kbId) {
        if (!ragQuestionStores.has(kbId)) {
            const fp = ragQuestionsJsonPath(settings.filesRoot, kbId);
            ragQuestionStores.set(kbId, RagQuestionsStore.open(fp, kbId, onRagChange));
        }
        return ragQuestionStores.get(kbId);
    }

    function getRuntimeConfig(kbId) {
        return RagRuntimeConfigStore.open(ragRuntimeConfigPath(settings.filesRoot, kbId)).load();
    }

    function updateRuntimeConfig(kbId, patch) {
        return RagRuntimeConfigStore.open(ragRuntimeConfigPath(settings.filesRoot, kbId)).update(patch);
    }

    function getRecallTestsStore(kbId) {
        return RagRecallTestsStore.open(ragRecallTestsJsonPath(settings.filesRoot, kbId));
    }

    return {
        settings,
        kbStore,
        opLog,
        ragModelsStore,
        weaviateStore,
        embeddingClient,
        ragLlmClient,
        getRagQuestionsStore,
        getRuntimeConfig,
        updateRuntimeConfig,
        getRecallTestsStore,
    };
}
