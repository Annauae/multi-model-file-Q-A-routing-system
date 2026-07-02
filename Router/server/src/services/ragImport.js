import fs from "node:fs";
import path from "node:path";
import {
    questionsJsonPath,
    ragKbAssetsDirPath,
    ragKbDirPath,
    kbAssetsDirPath,
    ragQuestionsJsonPath,
} from "./paths.js";

function copyDirIfMissing(src, dest) {
    if (!fs.existsSync(src))
        return;
    if (fs.existsSync(dest))
        return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
}

/** 从 RAG FAQ 复制条目到问答模型 FAQ，并同步 assets */
export function importRagFaqToLlm(ctx, llmKbId, ragKbId, { append = true, replace = false } = {}) {
    const { settings } = ctx;
    if (!ctx.kbStore.get(llmKbId))
        throw new Error(`问答模型知识库 ${llmKbId} 不存在`);
    if (!ctx.ragCtx.ragKbStore.get(ragKbId))
        throw new Error(`RAG 知识库 ${ragKbId} 不存在`);

    const ragPath = ragQuestionsJsonPath(settings.filesRoot, ragKbId);
    if (!fs.existsSync(ragPath))
        throw new Error(`RAG FAQ 文件不存在: ${ragKbId}`);

    const ragDoc = JSON.parse(fs.readFileSync(ragPath, "utf-8"));
    const sourceItems = (ragDoc.items || []).filter((it) => it && it.enabled !== false);
    if (!sourceItems.length)
        throw new Error("RAG FAQ 无可用条目");

    copyDirIfMissing(ragKbAssetsDirPath(settings.filesRoot, ragKbId), kbAssetsDirPath(settings.filesRoot, llmKbId));

    const llmStore = ctx.cache.store(llmKbId);
    const existing = llmStore.getDocument().items;
    const items = sourceItems.map((it) => ({
        id: it.id,
        question: it.question,
        variants: Array.isArray(it.variants) ? [...it.variants] : [],
        answer: it.answer,
        enabled: it.enabled !== false,
        updated_at: it.updated_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }));

    if (replace) {
        llmStore.replaceAll(1, items);
    }
    else if (append) {
        const byId = new Map(existing.map((it) => [it.id, it]));
        for (const item of items)
            byId.set(item.id, item);
        llmStore.replaceAll(1, [...byId.values()]);
    }
    else {
        llmStore.replaceAll(1, items);
    }

    ctx.cache.reloadKb(llmKbId);
    return { imported: items.length, llm_kb_id: llmKbId, rag_kb_id: ragKbId };
}

/** 从 LLM FAQ 复制条目到 RAG FAQ，并同步 assets */
export function importLlmFaqToRag(ctx, ragKbId, llmKbId, { append = true, replace = false } = {}) {
    const { settings, kbStore } = ctx;
    if (!kbStore.get(llmKbId))
        throw new Error(`LLM 知识库 ${llmKbId} 不存在`);

    const llmPath = questionsJsonPath(settings.filesRoot, llmKbId);
    if (!fs.existsSync(llmPath))
        throw new Error(`LLM FAQ 文件不存在: ${llmKbId}`);

    const llmDoc = JSON.parse(fs.readFileSync(llmPath, "utf-8"));
    const sourceItems = (llmDoc.items || []).filter((it) => it && it.enabled !== false);
    if (!sourceItems.length)
        throw new Error("LLM FAQ 无可用条目");

    fs.mkdirSync(ragKbDirPath(settings.filesRoot, ragKbId), { recursive: true });
    copyDirIfMissing(kbAssetsDirPath(settings.filesRoot, llmKbId), ragKbAssetsDirPath(settings.filesRoot, ragKbId));

    const ragStore = ctx.ragCtx.getRagQuestionsStore(ragKbId);
    const existing = ragStore.getDocument().items;
    const items = sourceItems.map((it) => ({
        id: it.id,
        question: it.question,
        variants: Array.isArray(it.variants) ? [...it.variants] : [],
        answer: it.answer,
        enabled: it.enabled !== false,
        updated_at: it.updated_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }));

    if (replace) {
        ragStore.replaceAll(1, items);
    }
    else if (append) {
        const byId = new Map(existing.map((it) => [it.id, it]));
        for (const item of items)
            byId.set(item.id, item);
        ragStore.replaceAll(1, [...byId.values()]);
    }
    else {
        ragStore.replaceAll(1, items);
    }

    return { imported: items.length, rag_kb_id: ragKbId, llm_kb_id: llmKbId };
}

export function ensureRagKbStructure(settings, ragKbId) {
    const dir = ragKbDirPath(settings.filesRoot, ragKbId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(ragKbAssetsDirPath(settings.filesRoot, ragKbId), { recursive: true });
    const qpath = ragQuestionsJsonPath(settings.filesRoot, ragKbId);
    if (!fs.existsSync(qpath)) {
        fs.writeFileSync(qpath, JSON.stringify({ version: 1, items: [] }, null, 2), "utf-8");
    }
}
