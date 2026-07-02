import { clipText, stripMarkdown } from "./textUtils.js";
import { normalizeApiUsage, usageFromRerankInput, usageFromText, estimateTextTokens } from "./tokenUtils.js";
import { activeTemplate } from "../ragRuntimeConfigStore.js";
import { DEFAULT_RAG_JUDGE_PROMPT, DEFAULT_RAG_LLM_PROMPT } from "../ragPromptsStore.js";

export class RagLlmClient {
    ragModelsStore;
    ragPromptsStore;

    constructor(ragModelsStore, ragPromptsStore = null) {
        this.ragModelsStore = ragModelsStore;
        this.ragPromptsStore = ragPromptsStore;
    }

    llmPromptTemplate(runtimeConfig) {
        const kbTemplate = activeTemplate(runtimeConfig).content?.trim();
        if (kbTemplate)
            return kbTemplate;
        return this.ragPromptsStore?.effectiveLlmPrompt() || DEFAULT_RAG_LLM_PROMPT;
    }

    judgePromptTemplate() {
        return this.ragPromptsStore?.effectiveJudgePrompt() || DEFAULT_RAG_JUDGE_PROMPT;
    }

    fillPrompt(template, vars) {
        let out = template;
        for (const [key, val] of Object.entries(vars))
            out = out.replaceAll(`{${key}}`, String(val ?? ""));
        return out;
    }

    slotEnabled(slot) {
        return Boolean(this.ragModelsStore.getSlot(slot).api_key?.trim());
    }

    headers(slot) {
        const cfg = this.ragModelsStore.getSlot(slot);
        return {
            Authorization: `Bearer ${cfg.api_key}`,
            "Content-Type": "application/json",
        };
    }

    async rerank(query, documents, topN) {
        if (!documents.length)
            return { ranked: [], usage: null };
        const cfg = this.ragModelsStore.getSlot("rerank");
        const fallbackRanked = (estimate = false) => ({
            ranked: documents.slice(0, topN).map((_, i) => [i, 1 / (i + 1)]),
            usage: estimate ? usageFromRerankInput(query, documents) : null,
        });
        if (!cfg.api_key?.trim())
            return fallbackRanked(false);
        try {
            const url = `${cfg.api_base_url.replace(/\/$/, "")}/rerank`;
            const resp = await fetch(url, {
                method: "POST",
                headers: this.headers("rerank"),
                body: JSON.stringify({
                    model: cfg.model,
                    query,
                    documents,
                    top_n: Math.min(topN, documents.length),
                    return_documents: false,
                }),
                signal: AbortSignal.timeout(120_000),
            });
            if (!resp.ok)
                throw new Error(await resp.text());
            const data = await resp.json();
            const ranked = (data.results ?? []).map((item) => [Number(item.index), Number(item.relevance_score ?? 0)]);
            const usage = normalizeApiUsage(data.usage)
                || usageFromRerankInput(query, documents);
            if (ranked.length)
                return { ranked, usage };
        }
        catch (err) {
            console.warn(`[rerank] rerank skipped: ${err}`);
        }
        return fallbackRanked(true);
    }

    async generateAnswer(query, sources, runtimeConfig) {
        const cfg = this.ragModelsStore.getSlot("llm");
        if (!sources.length)
            return { content: "未找到高置信答案。", usage: null };
        if (!cfg.api_key?.trim())
            return { content: sources[0].answer, usage: null };
        const context = sources
            .map((src, i) => `[来源 ${i + 1}] 主问题：${src.question}\n答案全文：${stripMarkdown(src.answer)}`)
            .join("\n\n");
        const template = this.llmPromptTemplate(runtimeConfig);
        const temperature = Number(runtimeConfig?.temperature ?? cfg.temperature ?? 0.1);
        const prompt = this.fillPrompt(template, { query, context });
        try {
            const url = `${cfg.api_base_url.replace(/\/$/, "")}/chat/completions`;
            const resp = await fetch(url, {
                method: "POST",
                headers: this.headers("llm"),
                body: JSON.stringify({
                    model: cfg.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature,
                    max_tokens: cfg.max_tokens || 1200,
                }),
                signal: AbortSignal.timeout(180_000),
            });
            if (!resp.ok)
                throw new Error(await resp.text());
            const data = await resp.json();
            const content = data.choices?.[0]?.message?.content;
            let usage = normalizeApiUsage(data.usage);
            if (content) {
                if (!usage)
                    usage = usageFromText(prompt, { completion: estimateTextTokens(content) });
                return { content, usage };
            }
        }
        catch (err) {
            console.warn(`[llm] generation skipped: ${err}`);
        }
        return { content: sources[0].answer, usage: null };
    }

    fallbackJudge(expectedAnswer, actualAnswer) {
        const exp = new Set(stripMarkdown(expectedAnswer));
        const act = new Set(stripMarkdown(actualAnswer));
        let overlap = 0;
        for (const ch of exp) {
            if (act.has(ch))
                overlap++;
        }
        const score = Math.max(0, Math.min(1, overlap / Math.max(1, exp.size)));
        return {
            quality_score: score,
            confidence: score,
            groundedness: score,
            image_support: 0,
            reason: "本地降级评估：按答案字符覆盖率粗略估计。",
            judge_error: "",
        };
    }

    async judge(query, expectedAnswer, actualAnswer, sources) {
        const fallback = this.fallbackJudge(expectedAnswer, actualAnswer);
        const cfg = this.ragModelsStore.getSlot("judge");
        if (!cfg.api_key?.trim())
            return fallback;
        const sourceText = sources
            .slice(0, 5)
            .map((src) => `- ${src.id}: ${src.question}`)
            .join("\n");
        const prompt = this.fillPrompt(this.judgePromptTemplate(), {
            query,
            expected: clipText(stripMarkdown(expectedAnswer), 1800),
            actual: clipText(stripMarkdown(actualAnswer), 1800),
            sources: sourceText,
        });
        try {
            const url = `${cfg.api_base_url.replace(/\/$/, "")}/chat/completions`;
            const resp = await fetch(url, {
                method: "POST",
                headers: this.headers("judge"),
                body: JSON.stringify({
                    model: cfg.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0,
                    max_tokens: cfg.max_tokens || 500,
                }),
                signal: AbortSignal.timeout(180_000),
            });
            if (!resp.ok)
                throw new Error(await resp.text());
            const content = (await resp.json()).choices?.[0]?.message?.content ?? "{}";
            const start = content.indexOf("{");
            const end = content.lastIndexOf("}");
            const parsed = JSON.parse(start >= 0 && end >= start ? content.slice(start, end + 1) : content);
            return { ...fallback, ...parsed };
        }
        catch (err) {
            return { ...fallback, judge_error: String(err) };
        }
    }
}
