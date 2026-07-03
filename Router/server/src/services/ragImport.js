import fs from "node:fs";
import path from "node:path";
import {
    ragKbAssetsDirPath,
    ragKbDirPath,
    kbAssetsDirPath,
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
export async function importRagFaqToLlm(ctx, llmKbId, ragKbId, { append = true, replace = false } = {}) {
    const { settings } = ctx;
    if (!ctx.kbStore.get(llmKbId))
        throw new Error(`问答模型知识库 ${llmKbId} 不存在`);
    if (!ctx.ragCtx.ragKbStore.get(ragKbId))
        throw new Error(`RAG 知识库 ${ragKbId} 不存在`);

    const ragStore = ctx.ragCtx.getRagQuestionsStore(ragKbId);
    const ragDoc = await ragStore.getDocument();
    const sourceItems = (ragDoc.items || []).filter((it) => it && it.enabled !== false);
    if (!sourceItems.length)
        throw new Error("RAG FAQ 无可用条目");

    copyDirIfMissing(ragKbAssetsDirPath(settings.filesRoot, ragKbId), kbAssetsDirPath(settings.filesRoot, llmKbId));

    const llmStore = ctx.cache.store(llmKbId);
    const existing = (await llmStore.getDocument()).items;
    const items = sourceItems.map((it) => ({
        id: it.id,
        question: it.question,
        variants: Array.isArray(it.variants) ? [...it.variants] : [],
        answer: it.answer,
        enabled: it.enabled !== false,
        updated_at: it.updated_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }));

    if (replace) {
        await llmStore.replaceAll(1, items);
    }
    else if (append) {
        const byId = new Map(existing.map((it) => [it.id, it]));
        for (const item of items)
            byId.set(item.id, item);
        await llmStore.replaceAll(1, [...byId.values()]);
    }
    else {
        await llmStore.replaceAll(1, items);
    }

    await ctx.cache.reloadKb(llmKbId);
    return { imported: items.length, llm_kb_id: llmKbId, rag_kb_id: ragKbId };
}

/** 从 LLM FAQ 复制条目到 RAG FAQ，并同步 assets */
export async function importLlmFaqToRag(ctx, ragKbId, llmKbId, { append = true, replace = false } = {}) {
    const { settings, kbStore } = ctx;
    if (!kbStore.get(llmKbId))
        throw new Error(`LLM 知识库 ${llmKbId} 不存在`);

    const llmStore = ctx.cache.store(llmKbId);
    const llmDoc = await llmStore.getDocument();
    const sourceItems = (llmDoc.items || []).filter((it) => it && it.enabled !== false);
    if (!sourceItems.length)
        throw new Error("LLM FAQ 无可用条目");

    copyDirIfMissing(kbAssetsDirPath(settings.filesRoot, llmKbId), ragKbAssetsDirPath(settings.filesRoot, ragKbId));

    const ragStore = ctx.ragCtx.getRagQuestionsStore(ragKbId);
    const existing = (await ragStore.getDocument()).items;
    const items = sourceItems.map((it) => ({
        id: it.id,
        question: it.question,
        variants: Array.isArray(it.variants) ? [...it.variants] : [],
        answer: it.answer,
        enabled: it.enabled !== false,
        updated_at: it.updated_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }));

    if (replace) {
        await ragStore.replaceAll(1, items);
    }
    else if (append) {
        const byId = new Map(existing.map((it) => [it.id, it]));
        for (const item of items)
            byId.set(item.id, item);
        await ragStore.replaceAll(1, [...byId.values()]);
    }
    else {
        await ragStore.replaceAll(1, items);
    }

    return { imported: items.length, llm_kb_id: llmKbId, rag_kb_id: ragKbId };
}

export function ensureRagKbStructure(settings, kbId) {
    const dir = ragKbDirPath(settings.filesRoot, kbId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(ragKbAssetsDirPath(settings.filesRoot, kbId), { recursive: true });
}
