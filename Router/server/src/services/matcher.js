/**
 * matcher.js — LLM 匹配提示词构建与输出解析
 *
 * system prompt 结构：
 *   [置信度匹配规则（来自 promptsStore.confidence_match_prompt）]
 *   【标准问题列表】
 *   q001|标准问题文本
 *   q001|变体问法
 *   ...
 */

export const DEFAULT_MATCH_PROMPT_ZH = `你是问题匹配器，不是回答器。
根据用户问题，从【标准问题列表】中选出语义最接近的一项。
列表中同一 id 可能出现多行（标准问题 + 其他问法），命中任意一行都输出该 id。
只输出该项的 id（如 q001）；无法匹配则只输出 NONE。
不要输出任何其他字符、标点、换行或解释。`;
export const DEFAULT_CONFIDENCE_MATCH_PROMPT_ZH = `你是问题匹配器，不是回答器。
根据用户问题，从【标准问题列表】中找出语义最接近的若干项（最多 {top_k} 项）。
列表中同一 id 可能出现多行（标准问题 + 其他问法），命中任意一行都计入该 id。

只输出 JSON 数组，按 confidence 从高到低排列，每项格式：{"id":"q001","confidence":0.95}
confidence 为 0~1 之间的小数，表示匹配置信度；同一 id 只出现一次。
若无任何可匹配项，输出 []。
不要输出任何其他字符、markdown 代码块或解释。`;
export const NONE_SENTINEL = "NONE";
export function defaultConfidenceMatchPrompt(topK = 5) {
    return DEFAULT_CONFIDENCE_MATCH_PROMPT_ZH.replace("{top_k}", String(topK));
}
export function defaultClarificationQuestion() {
    return "未找到相关问题，请换一种问法或补充更具体的功能名称。";
}
/** 将启用的 FAQ 项展开为多行 `id|question`，供 LLM 在列表中匹配 */
export function iterQuestionPromptLines(item) {
    const lines = [`${item.id}|${item.question}`];
    const seen = new Set([item.question.trim()]);
    for (const variant of item.variants || []) {
        const v = (variant || "").trim();
        if (!v || seen.has(v))
            continue;
        seen.add(v);
        lines.push(`${item.id}|${v}`);
    }
    return lines;
}
export function buildQuestionListSection(enabledItems) {
    const lines = ["【标准问题列表】"];
    for (const item of enabledItems) {
        lines.push(...iterQuestionPromptLines(item));
    }
    if (lines.length === 1)
        lines.push("(empty)");
    return lines.join("\n");
}
export function countQuestionPromptLines(enabledItems) {
    let total = 0;
    for (const item of enabledItems) {
        if (!item.enabled)
            continue;
        total += iterQuestionPromptLines(item).length;
    }
    return total;
}
/** 拼接完整 system prompt：规则 + 标准问题列表 */
export function buildConfidenceSystemPrompt(matchPrompt, enabledItems, topK = 5) {
    let rules = (matchPrompt || "").trim() || defaultConfidenceMatchPrompt(topK);
    if (rules.includes("{top_k}"))
        rules = rules.replace("{top_k}", String(topK));
    return `${rules}\n\n${buildQuestionListSection(enabledItems)}`;
}
/** OpenAI 风格 messages：system=FAQ列表+规则，user=用户问题（如「怎么安装吊带」） */
export function buildMatchMessages(systemPrompt, userQuestion) {
    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: (userQuestion || "").trim() },
    ];
}
function normalizeOutput(raw) {
    const text = (raw || "").trim();
    if (!text)
        return "";
    let firstLine = text.split(/\r?\n/)[0].trim();
    firstLine = firstLine.replace(/^[`"']+|[`"']+$/g, "");
    return firstLine.trim();
}
function stripJsonFence(text) {
    let raw = (text || "").trim();
    if (raw.startsWith("```")) {
        const lines = raw.split(/\r?\n/);
        if (lines[0]?.startsWith("```"))
            lines.shift();
        if (lines[lines.length - 1]?.trim() === "```")
            lines.pop();
        raw = lines.join("\n").trim();
    }
    return raw;
}
/**
 * 解析 LLM 返回的 JSON 数组。
 * - 去掉 markdown 代码块包裹
 * - 过滤不在 validIds 中的 id
 * - confidence 钳制到 [0,1]，按降序排列，截取 topK
 */
export function parseConfidenceRaw(raw, validIds, topK = 5) {
    const cleaned = stripJsonFence(raw);
    if (!cleaned)
        return { candidates: [], rawOutput: raw || "" };
    let data;
    try {
        data = JSON.parse(cleaned);
    }
    catch {
        return { candidates: [], rawOutput: raw || "" };
    }
    if (!Array.isArray(data))
        return { candidates: [], rawOutput: raw || "" };
    const seen = new Set();
    const out = [];
    for (const entry of data) {
        if (!entry || typeof entry !== "object")
            continue;
        const row = entry;
        const itemId = String(row.id || "").trim();
        if (!itemId || seen.has(itemId) || !validIds.has(itemId))
            continue;
        let confidence = Number(row.confidence ?? 0);
        if (Number.isNaN(confidence))
            continue;
        confidence = Math.max(0, Math.min(1, confidence));
        seen.add(itemId);
        out.push({ id: itemId, confidence });
    }
    out.sort((a, b) => b.confidence - a.confidence);
    return { candidates: out.slice(0, topK), rawOutput: raw || "" };
}
export { normalizeOutput, NONE_SENTINEL as noneSentinel };
