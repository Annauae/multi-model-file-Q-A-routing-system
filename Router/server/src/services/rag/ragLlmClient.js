import { clipText, stripMarkdown } from "./textUtils.js";
import { activeTemplate } from "../ragRuntimeConfigStore.js";

export class RagLlmClient {
    ragModelsStore;

    constructor(ragModelsStore) {
        this.ragModelsStore = ragModelsStore;
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
            return [];
        const cfg = this.ragModelsStore.getSlot("rerank");
        if (!cfg.api_key?.trim()) {
            return documents.slice(0, topN).map((_, i) => [i, 1 / (i + 1)]);
        }
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
            const ranked = (await resp.json()).results ?? [];
            const out = ranked.map((item) => [Number(item.index), Number(item.relevance_score ?? 0)]);
            if (out.length)
                return out;
        }
        catch (err) {
            console.warn(`[rerank] rerank skipped: ${err}`);
        }
        return documents.slice(0, topN).map((_, i) => [i, 1 / (i + 1)]);
    }

    async generateAnswer(query, sources, runtimeConfig) {
        const cfg = this.ragModelsStore.getSlot("llm");
        if (!sources.length)
            return "未找到高置信答案。";
        if (!cfg.api_key?.trim())
            return sources[0].answer;
        const context = sources
            .map((src, i) => `[来源 ${i + 1}] 主问题：${src.question}\n答案全文：${stripMarkdown(src.answer)}`)
            .join("\n\n");
        const template = activeTemplate(runtimeConfig).content
            || "用户问题：{query}\n\nFAQ 来源：\n{context}";
        const temperature = Number(runtimeConfig?.temperature ?? cfg.temperature ?? 0.1);
        let prompt;
        try {
            prompt = template.replace("{query}", query).replace("{context}", context);
        }
        catch {
            prompt = `${template}\n\n用户问题：${query}\n\nFAQ 来源：\n${context}`;
        }
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
            const choices = (await resp.json()).choices ?? [];
            const content = choices[0]?.message?.content;
            if (content)
                return content;
        }
        catch (err) {
            console.warn(`[llm] generation skipped: ${err}`);
        }
        return sources[0].answer;
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
        const prompt = "你是 RAG 评测裁判。请比较标准答案和系统答案，输出严格 JSON，不要输出额外文本。\n"
            + "JSON 字段：quality_score, confidence, groundedness, image_support, reason。\n"
            + "所有分数范围 0 到 1。\n\n"
            + `用户问题：${query}\n\n标准答案：${clipText(stripMarkdown(expectedAnswer), 1800)}\n\n`
            + `系统答案：${clipText(stripMarkdown(actualAnswer), 1800)}\n\n检索来源：\n${sourceText}`;
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
