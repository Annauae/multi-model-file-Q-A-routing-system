import * as settingsRepo from "../repositories/settingsRepo.js";
import { nowIso } from "../utils.js";

export const DEFAULT_RAG_LLM_PROMPT = "你是相机 FAQ 助手。请只根据给定 FAQ 来源回答，不能编造；"
    + "如果资料不足，请说明未找到高置信答案。回答使用简体中文。\n\n"
    + "用户问题：{query}\n\nFAQ 来源：\n{context}";

export const DEFAULT_RAG_EMBEDDING_PROMPT = "（Embedding API 按文本向量编码，无需提示词；此处预留说明或备注。）";
export const DEFAULT_RAG_RERANK_PROMPT = "（Rerank API 按 query+documents 相关性排序，无需提示词；此处预留说明或备注。）";

const SETTINGS_KEY = "rag_prompts";

export function allDefaultRagPrompts() {
    return {
        embedding_prompt: DEFAULT_RAG_EMBEDDING_PROMPT,
        rerank_prompt: DEFAULT_RAG_RERANK_PROMPT,
        llm_prompt: DEFAULT_RAG_LLM_PROMPT,
    };
}

export class RagPromptsStore {
    data = {
        embedding_prompt: "",
        rerank_prompt: "",
        llm_prompt: "",
        updated_at: "",
    };

    static open() {
        return new RagPromptsStore();
    }

    async init() {
        const row = await settingsRepo.getSetting(SETTINGS_KEY);
        if (!row) {
            this.data = { ...allDefaultRagPrompts(), updated_at: nowIso() };
            await this.save();
            return;
        }
        const raw = row.value;
        this.data = {
            embedding_prompt: String(raw.embedding_prompt ?? ""),
            rerank_prompt: String(raw.rerank_prompt ?? ""),
            llm_prompt: String(raw.llm_prompt ?? ""),
            updated_at: String(raw.updated_at ?? row.updated_at ?? ""),
        };
    }

    async save() {
        await settingsRepo.setSetting(SETTINGS_KEY, this.data);
    }

    get() {
        return { ...this.data };
    }

    async set(patch) {
        for (const key of ["embedding_prompt", "rerank_prompt", "llm_prompt"]) {
            if (key in patch)
                this.data[key] = String(patch[key] ?? "");
        }
        this.data.updated_at = nowIso();
        await this.save();
        return { ...this.data, defaults: allDefaultRagPrompts() };
    }

    effectiveLlmPrompt() {
        return this.get().llm_prompt.trim() || DEFAULT_RAG_LLM_PROMPT;
    }
}
