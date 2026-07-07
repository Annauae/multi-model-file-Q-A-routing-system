import { rebuildIndex } from "../services/rag/indexer.js";
import { indexStatus } from "../services/rag/indexStatus.js";
import { RagRetriever } from "../services/rag/retriever.js";
import { startEvalRun, getEvalRun, listEvalRuns } from "../services/rag/evaluator.js";
import { ensureRagKbStructure, importLlmFaqToRag } from "../services/ragImport.js";
import { allDefaultRagPrompts, DEFAULT_RAG_JUDGE_PROMPT, DEFAULT_RAG_LLM_PROMPT } from "../db/stores/ragPromptsStore.js";

function httpError(status, detail) {
    const e = new Error(detail);
    e.status = status;
    e.detail = detail;
    return e;
}

function validateRagKbId(ragCtx, kbId) {
    const kid = (kbId || "").trim();
    if (!kid)
        throw httpError(400, "kb_id 不能为空");
    if (!ragCtx.ragKbStore.get(kid))
        throw httpError(404, "RAG 知识库不存在");
    return kid;
}

async function ragEnabledCount(ragCtx, kbId) {
    try {
        const doc = await ragCtx.getRagQuestionsStore(kbId).getDocument();
        return doc.items.filter((it) => it.enabled !== false).length;
    }
    catch {
        return 0;
    }
}

export function registerRagRoutes(app, ctx, ragCtx) {
    app.get("/rag/health", async (_req, res) => {
        try {
            const ping = await ragCtx.weaviateStore.ping();
            const kbs = Object.keys(ragCtx.ragKbStore.getAll());
            const indexes = {};
            for (const kid of kbs) {
                indexes[kid] = await indexStatus(ragCtx.settings, kid, ragCtx.ragModelsStore);
            }
            res.json({ ok: true, weaviate: ping, indexes });
        }
        catch (e) {
            res.status(503).json({ ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/rag/knowledge-bases", async (_req, res) => {
        const items = [];
        for (const [kb_id, cfg] of Object.entries(ragCtx.ragKbStore.getAll())) {
            items.push({ kb_id, ...cfg, enabled_count: await ragEnabledCount(ragCtx, kb_id) });
        }
        res.json({ items });
    });

    app.post("/rag/knowledge-bases", async (req, res) => {
        try {
            const kbId = String(req.body.kb_id ?? "").trim() || (await ragCtx.ragKbStore.nextAvailableKbId());
            const name = String(req.body.name ?? "").trim();
            if (!name)
                throw httpError(400, "name 不能为空");
            const cfg = await ragCtx.ragKbStore.createKb(kbId, name);
            ensureRagKbStructure(ragCtx.settings, kbId);
            ragCtx.opLog.append({ module: "rag-manage", action: "kb-create", kb_id: kbId, detail: name });
            res.json({ kb_id: kbId, ...cfg });
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.delete("/rag/knowledge-bases/:kbId", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            const cfg = await ragCtx.ragKbStore.deleteKb(kid);
            ragCtx.ragKbStore.deleteKbFiles(kid, ragCtx.settings.filesRoot);
            try {
                await ragCtx.weaviateStore.deleteByKbId(kid);
            }
            catch (err) {
                console.warn(`[rag] delete weaviate kb=${kid}: ${err}`);
            }
            ragCtx.opLog.append({ module: "rag-manage", action: "kb-delete", kb_id: kid });
            res.json({ kb_id: kid, ...cfg });
        }
        catch (e) {
            res.status(e.status || 404).json({ detail: e.detail ?? e.message });
        }
    });

    app.post("/rag/knowledge-bases/:kbId/rename", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            const cfg = await ragCtx.ragKbStore.renameKb(kid, String(req.body.name ?? "").trim());
            res.json({ kb_id: kid, ...cfg });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.post("/rag/knowledge-bases/:ragKbId/import/from-llm", async (req, res) => {
        try {
            const ragKbId = validateRagKbId(ragCtx, req.params.ragKbId);
            const llmKbId = String(req.body.llm_kb_id ?? "").trim();
            if (!llmKbId)
                throw httpError(400, "llm_kb_id 必填");
            const result = await importLlmFaqToRag(ctx, ragKbId, llmKbId, {
                append: req.body.append !== false,
                replace: Boolean(req.body.replace),
            });
            let meta = null;
            if (req.body.auto_rebuild !== false) {
                meta = await rebuildIndex(ragKbId, ragCtx);
            }
            ragCtx.opLog.append({
                module: "rag-manage",
                action: "import-from-llm",
                kb_id: ragKbId,
                detail: `from llm ${llmKbId}, ${result.imported} items`,
            });
            res.json({ ok: true, ...result, meta });
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.get("/settings/rag-models", (_req, res) => {
        res.json({ slots: ragCtx.ragModelsStore.getAll(false) });
    });

    app.put("/settings/rag-models", async (req, res) => {
        try {
            const slots = await ragCtx.ragModelsStore.updateAll(req.body?.slots ?? req.body ?? {});
            res.json({ slots });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/settings/rag-prompts", (_req, res) => {
        const gp = ragCtx.ragPromptsStore.get();
        res.json({
            embedding_prompt: gp.embedding_prompt,
            rerank_prompt: gp.rerank_prompt,
            llm_prompt: gp.llm_prompt,
            judge_prompt: gp.judge_prompt,
            updated_at: gp.updated_at,
            defaults: allDefaultRagPrompts(),
            llm_system_preview: gp.llm_prompt.trim() || DEFAULT_RAG_LLM_PROMPT,
            judge_system_preview: gp.judge_prompt.trim() || DEFAULT_RAG_JUDGE_PROMPT,
        });
    });

    app.put("/settings/rag-prompts", async (req, res) => {
        try {
            const gp = await ragCtx.ragPromptsStore.set({
                embedding_prompt: "embedding_prompt" in req.body ? req.body.embedding_prompt : undefined,
                rerank_prompt: "rerank_prompt" in req.body ? req.body.rerank_prompt : undefined,
                llm_prompt: "llm_prompt" in req.body ? req.body.llm_prompt : undefined,
                judge_prompt: "judge_prompt" in req.body ? req.body.judge_prompt : undefined,
            });
            ragCtx.opLog.append({ module: "settings", action: "update_rag_prompts", detail: "更新 RAG 模型提示词" });
            res.json({ ...gp, defaults: allDefaultRagPrompts() });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/rag/knowledge-bases/:kbId/runtime-config", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            res.json(await ragCtx.getRuntimeConfig(kid));
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.put("/rag/knowledge-bases/:kbId/runtime-config", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            res.json(await ragCtx.updateRuntimeConfig(kid, req.body ?? {}));
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.get("/rag/knowledge-bases/:kbId/questions", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            res.json(await ragCtx.getRagQuestionsStore(kid).getDocument());
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.put("/rag/knowledge-bases/:kbId/questions", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            const store = ragCtx.getRagQuestionsStore(kid);
            const version = Number(req.body?.version ?? 1);
            const items = Array.isArray(req.body?.items) ? req.body.items : [];
            res.json(await store.replaceAll(version, items));
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.post("/rag/knowledge-bases/:kbId/questions/items", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            const item = await ragCtx.getRagQuestionsStore(kid).upsertItem(req.body ?? {});
            ragCtx.opLog.append({ module: "rag-manage", action: "create", kb_id: kid, detail: item.id });
            res.json(item);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.put("/rag/knowledge-bases/:kbId/questions/items/:itemId", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            const body = { ...req.body, id: req.params.itemId };
            const item = await ragCtx.getRagQuestionsStore(kid).upsertItem(body);
            ragCtx.opLog.append({ module: "rag-manage", action: "update", kb_id: kid, detail: item.id });
            res.json(item);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.delete("/rag/knowledge-bases/:kbId/questions/items/:itemId", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            const deleted = await ragCtx.getRagQuestionsStore(kid).deleteItem(req.params.itemId);
            ragCtx.opLog.append({ module: "rag-manage", action: "delete", kb_id: kid, detail: req.params.itemId });
            res.json(deleted);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.post("/rag/knowledge-bases/:kbId/index/rebuild", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            const meta = await rebuildIndex(kid, ragCtx);
            ragCtx.opLog.append({
                module: "rag",
                action: "rebuild",
                kb_id: kid,
                kind: "result",
                detail: `索引重建完成 items=${meta.items} search_docs=${meta.search_docs} holdout=${meta.holdout_docs} `
                    + `embedding=${meta.embedding_model} dim=${meta.embedding_dim} built_at=${meta.built_at}`,
            });
            res.json({ ok: true, meta });
        }
        catch (e) {
            res.status(500).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/rag/knowledge-bases/:kbId/index/status", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            res.json(await indexStatus(ragCtx.settings, kid, ragCtx.ragModelsStore));
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    async function handleSearch(req, res) {
        try {
            const queryText = String(req.body?.query ?? req.query?.q ?? "").trim();
            if (!queryText)
                throw httpError(400, "query 不能为空");
            const kbId = validateRagKbId(ragCtx, req.body?.kb_id ?? req.query?.kb_id);
            const status = await indexStatus(ragCtx.settings, kbId, ragCtx.ragModelsStore);
            if (!status.ready)
                return res.status(409).json({ detail: status.reason || "索引不存在，请先重建索引" });
            const topK = Math.max(1, Math.min(50, Number(req.body?.top_k ?? req.query?.top_k ?? 8)));
            const runtime = await ragCtx.getRuntimeConfig(kbId);
            const retriever = new RagRetriever(kbId, ragCtx, runtime);
            const { results, timing, tokens, token_breakdown } = await retriever.search(queryText, topK);
            ragCtx.opLog.append({
                module: "rag-debug",
                action: "search",
                kb_id: kbId,
                kind: "result",
                detail: `query="${queryText.slice(0, 80)}" hits=${results.length} total_ms=${Number(timing.total_ms || 0).toFixed(1)}`,
            });
            res.json({ query: queryText, results, timing, tokens, token_breakdown });
        }
        catch (e) {
            if (e.status)
                return res.status(e.status).json({ detail: e.detail });
            res.status(500).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    }

    app.get("/rag/search", (req, res) => void handleSearch(req, res));
    app.post("/rag/search", (req, res) => void handleSearch(req, res));

    /**
     * RAG 完整问答 — 调试页「问答」按钮调用此路由（非 SSE，一次性 JSON 返回）
     *
     * 请求体：{ query, kb_id, top_n?, use_llm_answer? }
     * 流程：indexStatus 检查索引 → RagRetriever.chat() → 检索 + 置信判定 + 直出/合成
     */
    app.post("/rag/chat", async (req, res) => {
        try {
            const queryText = String(req.body?.query ?? "").trim();
            if (!queryText)
                throw httpError(400, "query 不能为空");
            const kbId = validateRagKbId(ragCtx, req.body?.kb_id);
            // 索引未构建或过期则 409，前端 Toast 提示「请先重建索引」
            const status = await indexStatus(ragCtx.settings, kbId, ragCtx.ragModelsStore);
            if (!status.ready)
                return res.status(409).json({ detail: status.reason || "索引不存在，请先重建索引" });
            const runtime = await ragCtx.getRuntimeConfig(kbId);
            const retriever = new RagRetriever(kbId, ragCtx, runtime);
            const out = await retriever.chat(queryText, {
                topN: req.body?.top_n,
                useLlmAnswer: req.body?.use_llm_answer,
            });
            ragCtx.opLog.append({
                module: "rag-debug",
                action: "chat",
                kb_id: kbId,
                kind: "result",
                detail: `query="${queryText.slice(0, 80)}" mode=${out.mode} confidence=${Number(out.confidence || 0).toFixed(4)} `
                    + `sources=${out.sources?.length ?? 0} total_ms=${Number(out.timing?.total_ms || 0).toFixed(1)}`,
            });
            res.json({ query: queryText, ...out });
        }
        catch (e) {
            if (e.status)
                return res.status(e.status).json({ detail: e.detail });
            res.status(500).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/rag/knowledge-bases/:kbId/recall-tests", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            res.json(await ragCtx.getRecallTestsStore(kid).getDocument());
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.put("/rag/knowledge-bases/:kbId/recall-tests", async (req, res) => {
        try {
            const kid = validateRagKbId(ragCtx, req.params.kbId);
            res.json(await ragCtx.getRecallTestsStore(kid).replaceAll(req.body ?? {}));
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.post("/rag/eval/run", async (req, res) => {
        try {
            const kbId = validateRagKbId(ragCtx, req.body?.kb_id);
            const size = [10, 50, 100].includes(Number(req.body?.size)) ? Number(req.body.size) : 10;
            const mode = String(req.body?.mode ?? "mixed");
            const top_k = Math.max(1, Math.min(20, Number(req.body?.top_k ?? 5)));
            const runId = await startEvalRun(kbId, { size, mode, top_k }, ragCtx);
            res.json({ run_id: runId, status: "queued" });
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.get("/rag/eval/runs", async (req, res) => {
        try {
            const kbId = validateRagKbId(ragCtx, req.query?.kb_id);
            const limit = Math.max(1, Math.min(50, Number(req.query?.limit ?? 10)));
            res.json({ runs: await listEvalRuns(kbId, limit) });
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.get("/rag/eval/runs/:runId", async (req, res) => {
        try {
            const kbId = validateRagKbId(ragCtx, req.query?.kb_id);
            const run = await getEvalRun(kbId, req.params.runId);
            if (!run)
                return res.status(404).json({ detail: "eval run not found" });
            res.json(run);
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });
}
