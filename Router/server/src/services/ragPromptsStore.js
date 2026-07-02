import fs from "node:fs";
import path from "node:path";

export const DEFAULT_RAG_LLM_PROMPT = "你是相机 FAQ 助手。请只根据给定 FAQ 来源回答，不能编造；"
    + "如果资料不足，请说明未找到高置信答案。回答使用简体中文。\n\n"
    + "用户问题：{query}\n\nFAQ 来源：\n{context}";

export const DEFAULT_RAG_JUDGE_PROMPT = "你是 RAG 评测裁判。请比较标准答案和系统答案，输出严格 JSON，不要输出额外文本。\n"
    + "JSON 字段：quality_score, confidence, groundedness, image_support, reason。\n"
    + "所有分数范围 0 到 1。\n\n"
    + "用户问题：{query}\n\n标准答案：{expected}\n\n系统答案：{actual}\n\n检索来源：\n{sources}";

export const DEFAULT_RAG_EMBEDDING_PROMPT = "（Embedding API 按文本向量编码，无需提示词；此处预留说明或备注。）";
export const DEFAULT_RAG_RERANK_PROMPT = "（Rerank API 按 query+documents 相关性排序，无需提示词；此处预留说明或备注。）";

function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function allDefaultRagPrompts() {
    return {
        embedding_prompt: DEFAULT_RAG_EMBEDDING_PROMPT,
        rerank_prompt: DEFAULT_RAG_RERANK_PROMPT,
        llm_prompt: DEFAULT_RAG_LLM_PROMPT,
        judge_prompt: DEFAULT_RAG_JUDGE_PROMPT,
    };
}

export class RagPromptsStore {
    filePath;
    data = {
        embedding_prompt: "",
        rerank_prompt: "",
        llm_prompt: "",
        judge_prompt: "",
        updated_at: "",
    };

    constructor(filePath) {
        this.filePath = filePath;
        this.loadOrSeed();
    }

    static open(filePath) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        return new RagPromptsStore(filePath);
    }

    loadOrSeed() {
        if (!fs.existsSync(this.filePath)) {
            this.data = { ...allDefaultRagPrompts(), updated_at: nowIso() };
            this.save();
            return;
        }
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        this.data = {
            embedding_prompt: String(raw.embedding_prompt ?? ""),
            rerank_prompt: String(raw.rerank_prompt ?? ""),
            llm_prompt: String(raw.llm_prompt ?? ""),
            judge_prompt: String(raw.judge_prompt ?? ""),
            updated_at: String(raw.updated_at ?? ""),
        };
    }

    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    }

    get() {
        return { ...this.data };
    }

    set(patch) {
        for (const key of ["embedding_prompt", "rerank_prompt", "llm_prompt", "judge_prompt"]) {
            if (key in patch)
                this.data[key] = String(patch[key] ?? "");
        }
        this.data.updated_at = nowIso();
        this.save();
        return { ...this.data, defaults: allDefaultRagPrompts() };
    }

    effectiveLlmPrompt() {
        return this.get().llm_prompt.trim() || DEFAULT_RAG_LLM_PROMPT;
    }

    effectiveJudgePrompt() {
        return this.get().judge_prompt.trim() || DEFAULT_RAG_JUDGE_PROMPT;
    }
}
