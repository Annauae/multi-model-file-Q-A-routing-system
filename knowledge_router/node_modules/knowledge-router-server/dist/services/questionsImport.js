import { LLMError } from "./llmClient.js";
import { DEFAULT_FAQ_QUESTIONS_PROMPT_ZH } from "./promptDefaults.js";
export function stripMdFrontmatter(text) {
    let body = text || "";
    if (body.startsWith("---")) {
        const end = body.indexOf("\n---", 3);
        if (end !== -1)
            body = body.slice(end + 4);
    }
    return body.trim();
}
function extractFirstJsonObject(text) {
    const s = (text || "").trim();
    if (!s)
        throw new Error("模型输出为空");
    if (s.startsWith("{") && s.endsWith("}"))
        return s;
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start)
        throw new Error("模型输出不包含 JSON 对象");
    return s.slice(start, end + 1);
}
function normalizeQuestionsOnly(row) {
    if (!row || typeof row !== "object")
        return null;
    const r = row;
    const question = String(r.question ?? "").trim();
    if (!question)
        return null;
    let variants = [];
    if (Array.isArray(r.variants)) {
        for (const v of r.variants) {
            const s = String(v).trim();
            if (s && !variants.includes(s))
                variants.push(s);
        }
    }
    variants = variants.slice(0, 3);
    if (!variants.length)
        variants = [question];
    return { question, variants };
}
export async function generateFaqQuestionsOnly(answerMd, llm, importModel, systemPrompt = "") {
    const body = stripMdFrontmatter(answerMd);
    if (!body.trim())
        throw new LLMError("回答内容为空");
    const prompt = (systemPrompt || "").trim() || DEFAULT_FAQ_QUESTIONS_PROMPT_ZH;
    const [raw, usage] = await llm.chat({
        model: importModel,
        messages: [
            { role: "system", content: prompt },
            { role: "user", content: JSON.stringify({ markdown: body }) },
        ],
        max_tokens: 4096,
        temperature: 0.2,
    });
    try {
        const obj = JSON.parse(extractFirstJsonObject(raw));
        const item = normalizeQuestionsOnly(obj);
        if (!item)
            throw new Error("未生成有效问法");
        return [item, usage];
    }
    catch (e) {
        throw new LLMError(`问法生成解析失败：${e instanceof Error ? e.message : e}`);
    }
}
export function assignQuestionIds(items, start = 1) {
    return items.map((item, i) => ({
        ...item,
        id: `q${String(start + i).padStart(3, "0")}`,
        enabled: item.enabled !== false,
        updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }));
}
