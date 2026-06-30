import fs from "node:fs";
import { extractImageRefs } from "./media.js";
import { answerSummary, stableHash, stripMarkdown } from "./textUtils.js";

function asStr(value, field, itemId) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${itemId}: \`${field}\` must be a non-empty string`);
    return value.trim();
}

export function parseItem(raw, assetsDir) {
    const itemId = asStr(raw?.id, "id", "<unknown>");
    const variantsRaw = raw?.variants;
    if (!Array.isArray(variantsRaw))
        throw new Error(`${itemId}: \`variants\` must be a list`);
    const variants = variantsRaw.map((v) => String(v).trim()).filter(Boolean);
    const answer = asStr(raw?.answer, "answer", itemId);
    return {
        id: itemId,
        question: asStr(raw?.question, "question", itemId),
        variants,
        answer,
        enabled: raw?.enabled !== false,
        updated_at: asStr(raw?.updated_at, "updated_at", itemId),
        answer_text: stripMarkdown(answer),
        answer_summary: answerSummary(answer),
        images: extractImageRefs(answer, assetsDir),
    };
}

export function loadFaqItems(filePath, assetsDir, { includeDisabled = false } = {}) {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const itemsRaw = data.items;
    if (!Array.isArray(itemsRaw))
        throw new Error("questions.json must contain an `items` list");
    let items = itemsRaw
        .filter((raw) => raw && typeof raw === "object")
        .map((raw) => parseItem(raw, assetsDir));
    if (!includeDisabled)
        items = items.filter((item) => item.enabled);
    return items;
}

export function dataHashFromContent(content) {
    return stableHash(content);
}

export function dataHashFromFile(filePath) {
    return stableHash(fs.readFileSync(filePath, "utf-8"));
}

export function itemToResult(item, scores = {}) {
    return {
        id: item.id,
        question: item.question,
        answer: item.answer,
        answer_summary: item.answer_summary,
        updated_at: item.updated_at,
        images: item.images,
        variants: item.variants,
        ...scores,
    };
}

export function buildItemMap(items) {
    const map = new Map();
    for (const item of items)
        map.set(item.id, item);
    return map;
}
