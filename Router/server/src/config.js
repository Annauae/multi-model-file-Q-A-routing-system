import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, "../..");
function firstEnv(...keys) {
    for (const key of keys) {
        const val = (process.env[key] ?? "").trim();
        if (val)
            return val;
    }
    return "";
}
function truthy(val) {
    return ["1", "true", "True", "YES", "yes"].includes((val ?? "").trim());
}
export function loadSettings() {
    loadDotenv({ path: path.join(APP_ROOT, ".env") });
    const matchModel = firstEnv("MATCH_MODEL", "INIT_MODEL", "ANSWER_MODEL") || "gpt-4.1-mini";
    const importModel = firstEnv("IMPORT_MODEL", "INIT_MODEL", "MATCH_MODEL") || matchModel;
    const tempRaw = firstEnv("MATCH_TEMPERATURE", "LLM_TEMPERATURE") || "0";
    const enableThinkingRaw = (process.env.ENABLE_THINKING ?? "").trim().toLowerCase();
    const disableThinking = truthy(process.env.DISABLE_THINKING ?? "1");
    let enableThinking;
    if (["1", "true", "yes"].includes(enableThinkingRaw))
        enableThinking = true;
    else if (["0", "false", "no"].includes(enableThinkingRaw))
        enableThinking = false;
    else if (disableThinking)
        enableThinking = false;
    else
        enableThinking = null;
    const reasoningEffortRaw = (process.env.REASONING_EFFORT ?? "").trim().toLowerCase();
    const reasoningEffort = ["low", "medium", "high"].includes(reasoningEffortRaw)
        ? reasoningEffortRaw
        : null;
    const dataRoot = path.resolve(process.env.DATA_ROOT || APP_ROOT);
    const filesRoot = path.resolve(process.env.FILES_ROOT || path.join(dataRoot, "files"));
    return {
        apiBaseUrl: (process.env.API_BASE_URL || "https://api.openai.com/v1").trim(),
        apiKey: (process.env.API_KEY || process.env.ARK_API_KEY || "").trim(),
        matchModel,
        importModel,
        maxTokens: parseInt(process.env.MAX_TOKENS || "4096", 10),
        matchMaxTokens: Math.max(16, parseInt(process.env.MATCH_MAX_TOKENS || "8", 10)),
        confidenceMaxTokens: Math.max(64, parseInt(process.env.CONFIDENCE_MAX_TOKENS || "512", 10)),
        confidenceTopK: Math.max(1, Math.min(20, parseInt(process.env.CONFIDENCE_TOP_K || "5", 10))),
        matchTemperature: Math.max(0, Math.min(2, parseFloat(tempRaw))),
        useMaxCompletionTokens: truthy(process.env.USE_MAX_COMPLETION_TOKENS),
        mockLlm: truthy(process.env.MOCK_LLM),
        useContentParts: truthy(process.env.USE_CONTENT_PARTS),
        enableThinking,
        reasoningEffort,
        dataRoot,
        kbConfigPath: path.resolve(process.env.KB_CONFIG_PATH || path.join(dataRoot, "config", "knowledge_bases.json")),
        ragKbConfigPath: path.resolve(process.env.RAG_KB_CONFIG_PATH || path.join(dataRoot, "config", "rag_knowledge_bases.json")),
        filesRoot,
        debugRequestTimeoutS: Math.max(1, parseInt(process.env.DEBUG_REQUEST_TIMEOUT_S || "60", 10)),
        weaviateUrl: (process.env.WEAVIATE_URL || "").trim(),
        weaviateApiKey: (process.env.WEAVIATE_API_KEY || "").trim(),
        weaviateClass: (process.env.WEAVIATE_CLASS || "FaqSearchDoc").trim(),
        ragEmbeddingModel: firstEnv("RAG_EMBEDDING_MODEL", "EMBEDDING_MODEL") || "BAAI/bge-m3",
        ragRerankModel: firstEnv("RAG_RERANK_MODEL", "RERANK_MODEL") || "BAAI/bge-reranker-v2-m3",
        ragLlmModel: firstEnv("RAG_LLM_MODEL", "LLM_MODEL") || "Qwen/Qwen3-VL-8B-Instruct",
        ragVectorTopK: Math.max(1, parseInt(process.env.RAG_VECTOR_TOP_K || process.env.VECTOR_TOP_K || "30", 10)),
        ragKeywordTopK: Math.max(1, parseInt(process.env.RAG_KEYWORD_TOP_K || process.env.KEYWORD_TOP_K || "30", 10)),
        ragRrfK: Math.max(1, parseInt(process.env.RAG_RRF_K || process.env.RRF_K || "60", 10)),
        ragEvalHoldoutPerItem: Math.max(0, parseInt(process.env.RAG_EVAL_HOLDOUT_PER_ITEM || process.env.EVAL_HOLDOUT_PER_ITEM || "1", 10)),
        siliconflowBaseUrl: (process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1").trim().replace(/\/$/, ""),
        useApiEmbedding: !truthy(process.env.DISABLE_API_EMBEDDING ?? "0"),
        hashEmbeddingDim: Math.max(64, parseInt(process.env.HASH_EMBEDDING_DIM || "1024", 10)),
        embeddingBatchSize: Math.max(1, parseInt(process.env.EMBEDDING_BATCH_SIZE || "16", 10)),
        embeddingSleepSec: Math.max(0, parseFloat(process.env.EMBEDDING_SLEEP_SEC || "0.25")),
        embeddingMaxChars: Math.max(256, parseInt(process.env.EMBEDDING_MAX_CHARS || "6000", 10)),
        mockWeaviate: truthy(process.env.MOCK_WEAVIATE),
        databaseUrl: (process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || "").trim(),
        databasePoolSize: Math.max(1, parseInt(process.env.DATABASE_POOL_SIZE || "20", 10)),
    };
}
