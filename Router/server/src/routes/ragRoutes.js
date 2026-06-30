import { rebuildIndex } from "../services/rag/indexer.js";
import { indexStatus } from "../services/rag/indexStatus.js";
import { RagRetriever } from "../services/rag/retriever.js";
import { startEvalRun, getEvalRun, listEvalRuns } from "../services/rag/evaluator.js";

function httpError(status, detail) {
    const e = new Error(detail);
    e.status = status;
    e.detail = detail;
    return e;
}

function validateKbId(ctx, kbId) {
    const kid = (kbId || "").trim();
    if (!kid)
        throw httpError(400, "kb_id 不能为空");
    if (!ctx.kbStore.get(kid))
        throw httpError(404, "kb_id 不存在");
    return kid;
}

export function registerRagRoutes(app, ctx, ragCtx) {
    app.get("/rag/health", async (_req, res) => {
        try {
            const ping = await ragCtx.weaviateStore.ping();
            const kbs = Object.keys(ctx.kbStore.getAll());
            const indexes = {};
            for (const kid of kbs) {
                indexes[kid] = indexStatus(ragCtx.settings, kid, ragCtx.ragModelsStore);
            }
            res.json({ ok: true, weaviate: ping, indexes });
        }
        catch (e) {
            res.status(503).json({ ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/settings/rag-models", (_req, res) => {
        res.json({ slots: ragCtx.ragModelsStore.getAll(true) });
    });

    app.put("/settings/rag-models", (req, res) => {
        try {
            const slots = ragCtx.ragModelsStore.updateAll(req.body?.slots ?? req.body ?? {});
            res.json({ slots: Object.fromEntries(
                Object.entries(slots).map(([k, v]) => [k, ragCtx.ragModelsStore.toDict(v, true)]),
            ) });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/rag/knowledge-bases/:kbId/runtime-config", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(ragCtx.getRuntimeConfig(kid));
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.put("/rag/knowledge-bases/:kbId/runtime-config", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(ragCtx.updateRuntimeConfig(kid, req.body ?? {}));
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.get("/rag/knowledge-bases/:kbId/questions", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(ragCtx.getRagQuestionsStore(kid).getDocument());
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.put("/rag/knowledge-bases/:kbId/questions", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const store = ragCtx.getRagQuestionsStore(kid);
            const version = Number(req.body?.version ?? 1);
            const items = Array.isArray(req.body?.items) ? req.body.items : [];
            res.json(store.replaceAll(version, items));
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.post("/rag/knowledge-bases/:kbId/questions/items", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const item = ragCtx.getRagQuestionsStore(kid).upsertItem(req.body ?? {});
            ragCtx.opLog.append({ module: "rag-manage", action: "create", kb_id: kid, detail: item.id });
            res.json(item);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.put("/rag/knowledge-bases/:kbId/questions/items/:itemId", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const body = { ...req.body, id: req.params.itemId };
            const item = ragCtx.getRagQuestionsStore(kid).upsertItem(body);
            ragCtx.opLog.append({ module: "rag-manage", action: "update", kb_id: kid, detail: item.id });
            res.json(item);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.delete("/rag/knowledge-bases/:kbId/questions/items/:itemId", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const deleted = ragCtx.getRagQuestionsStore(kid).deleteItem(req.params.itemId);
            ragCtx.opLog.append({ module: "rag-manage", action: "delete", kb_id: kid, detail: req.params.itemId });
            res.json(deleted);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.post("/rag/knowledge-bases/:kbId/index/rebuild", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const meta = await rebuildIndex(kid, ragCtx);
            ragCtx.opLog.append({ module: "rag", action: "rebuild", kb_id: kid, detail: `docs=${meta.search_docs}` });
            res.json({ ok: true, meta });
        }
        catch (e) {
            res.status(500).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/rag/knowledge-bases/:kbId/index/status", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(indexStatus(ragCtx.settings, kid, ragCtx.ragModelsStore));
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    async function handleSearch(req, res) {
        try {
            const query = String(req.body?.query ?? req.query?.q ?? "").trim();
            if (!query)
                throw httpError(400, "query 不能为空");
            const kbId = validateKbId(ctx, req.body?.kb_id ?? req.query?.kb_id);
            const status = indexStatus(ragCtx.settings, kbId, ragCtx.ragModelsStore);
            if (!status.ready)
                return res.status(409).json({ detail: status.reason || "索引不存在，请先重建索引" });
            const topK = Math.max(1, Math.min(50, Number(req.body?.top_k ?? req.query?.top_k ?? 8)));
            const runtime = ragCtx.getRuntimeConfig(kbId);
            const retriever = new RagRetriever(kbId, ragCtx, runtime);
            const { results, timing } = await retriever.search(query, topK);
            res.json({ query, results, timing });
        }
        catch (e) {
            if (e.status)
                return res.status(e.status).json({ detail: e.detail });
            res.status(500).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    }

    app.get("/rag/search", (req, res) => void handleSearch(req, res));
    app.post("/rag/search", (req, res) => void handleSearch(req, res));

    app.post("/rag/chat", async (req, res) => {
        try {
            const query = String(req.body?.query ?? "").trim();
            if (!query)
                throw httpError(400, "query 不能为空");
            const kbId = validateKbId(ctx, req.body?.kb_id);
            const status = indexStatus(ragCtx.settings, kbId, ragCtx.ragModelsStore);
            if (!status.ready)
                return res.status(409).json({ detail: status.reason || "索引不存在，请先重建索引" });
            const runtime = ragCtx.getRuntimeConfig(kbId);
            const retriever = new RagRetriever(kbId, ragCtx, runtime);
            const out = await retriever.chat(query, {
                topN: req.body?.top_n,
                useLlmAnswer: req.body?.use_llm_answer,
            });
            ragCtx.opLog.append({ module: "rag-debug", action: "chat", kb_id: kbId, detail: query.slice(0, 80) });
            res.json({ query, ...out });
        }
        catch (e) {
            if (e.status)
                return res.status(e.status).json({ detail: e.detail });
            res.status(500).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/rag/knowledge-bases/:kbId/recall-tests", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(ragCtx.getRecallTestsStore(kid).getDocument());
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.put("/rag/knowledge-bases/:kbId/recall-tests", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(ragCtx.getRecallTestsStore(kid).replaceAll(req.body ?? {}));
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });

    app.post("/rag/eval/run", (req, res) => {
        try {
            const kbId = validateKbId(ctx, req.body?.kb_id);
            const size = [10, 50, 100].includes(Number(req.body?.size)) ? Number(req.body.size) : 10;
            const mode = String(req.body?.mode ?? "mixed");
            const top_k = Math.max(1, Math.min(20, Number(req.body?.top_k ?? 5)));
            const runId = startEvalRun(kbId, { size, mode, top_k }, ragCtx);
            res.json({ run_id: runId, status: "queued" });
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.get("/rag/eval/runs", (req, res) => {
        try {
            const kbId = validateKbId(ctx, req.query?.kb_id);
            const limit = Math.max(1, Math.min(50, Number(req.query?.limit ?? 10)));
            res.json({ runs: listEvalRuns(ragCtx.settings.filesRoot, kbId, limit) });
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });

    app.get("/rag/eval/runs/:runId", (req, res) => {
        try {
            const kbId = validateKbId(ctx, req.query?.kb_id);
            const run = getEvalRun(ragCtx.settings.filesRoot, kbId, req.params.runId);
            if (!run)
                return res.status(404).json({ detail: "eval run not found" });
            res.json(run);
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? e.message });
        }
    });
}
