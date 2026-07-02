/** 粗略估算文本 token（中文约 1 字 1 token，其它字符约 4 字 1 token） */
export function estimateTextTokens(text) {
    if (!text)
        return 0;
    let n = 0;
    for (const ch of String(text)) {
        if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(ch))
            n += 1;
        else if (!/\s/.test(ch))
            n += 0.25;
    }
    return Math.max(0, Math.ceil(n));
}

/** @param {string} text */
export function usageFromText(text, { completion = 0 } = {}) {
    const prompt = estimateTextTokens(text);
    const completion_tokens = Math.max(0, Math.ceil(completion));
    return {
        prompt_tokens: prompt,
        completion_tokens,
        total_tokens: prompt + completion_tokens,
    };
}

/** @param {string} query @param {string[]} documents */
export function usageFromRerankInput(query, documents) {
    const body = [query, ...(documents || [])].join("\n");
    return usageFromText(body);
}

/** @param {import("../../types.js").TokenUsage | null | undefined} a */
/** @param {import("../../types.js").TokenUsage | null | undefined} b */
export function sumTokenUsage(a, b) {
    const x = a || {};
    const y = b || {};
    return {
        prompt_tokens: (x.prompt_tokens || 0) + (y.prompt_tokens || 0),
        completion_tokens: (x.completion_tokens || 0) + (y.completion_tokens || 0),
        total_tokens: (x.total_tokens || 0) + (y.total_tokens || 0),
    };
}

/** @param {{ phase: string; usage: import("../../types.js").TokenUsage }[]} breakdown */
export function aggregateTokens(breakdown) {
    const items = (breakdown || []).filter((row) => row?.usage && (row.usage.total_tokens || row.usage.prompt_tokens || row.usage.completion_tokens));
    if (!items.length)
        return { tokens: null, token_breakdown: [] };
    let total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (const row of items) {
        total = sumTokenUsage(total, row.usage);
    }
    if (!total.total_tokens)
        total.total_tokens = total.prompt_tokens + total.completion_tokens;
    return { tokens: total, token_breakdown: items };
}

/** @param {Record<string, unknown> | null | undefined} usage */
export function normalizeApiUsage(usage) {
    if (!usage || typeof usage !== "object")
        return null;
    const prompt = Number(usage.prompt_tokens ?? 0);
    const completion = Number(usage.completion_tokens ?? 0);
    const total = Number(usage.total_tokens ?? prompt + completion);
    if (!prompt && !completion && !total)
        return null;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}
