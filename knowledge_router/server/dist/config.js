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
        filesRoot,
        debugRequestTimeoutS: Math.max(1, parseInt(process.env.DEBUG_REQUEST_TIMEOUT_S || "60", 10)),
    };
}
