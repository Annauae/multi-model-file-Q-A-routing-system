import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import { APP_ROOT, loadSettings } from "./config.js";
import { KbStore } from "./db/stores/kbStore.js";
import { QuestionsCache } from "./services/questionsCache.js";
import { ModelsStore } from "./db/stores/modelsStore.js";
import { MatchProfilesStore } from "./db/stores/matchProfilesStore.js";
import { PromptsStore } from "./db/stores/promptsStore.js";
import { OperationLog } from "./db/stores/operationLog.js";
import { LLMClient, LLMError } from "./services/llmClient.js";
import { AskLogSink, runConfidenceMatch, sseEvent, } from "./services/confidenceMatch.js";
import { kbAssetsDirPath, kbDirPath, documentsAssetsDirPath, documentsSourcesDirPath, } from "./services/paths.js";
import { buildMarkdownFilesTree, readDocumentContent, saveMarkdownContent, deleteDocumentFile, renameDocumentFile, createModuleMarkdown, documentsSourcePath, resolvePreviewFilePath, listExcelSheets, } from "./services/markdownFiles.js";
import { extractMarkdownRange, extractPdfToMarkdown, extractSourceToMarkdown, mergeExtractStats, finalizeCombinedExtract, detectSourceFormat, } from "./services/fileProcessor.js";
import { isAllowedSourceExtension, fileKind as docFileKind, capabilitiesForKind, formatFromFilename, listCapabilitiesPayload, } from "./services/documentTypes.js";
import { assignQuestionIds, generateFaqQuestionsOnly } from "./services/questionsImport.js";
import { importRagFaqToLlm } from "./services/ragImport.js";
import { allDefaultPrompts } from "./services/promptDefaults.js";
import { buildQuestionListSection, defaultConfidenceMatchPrompt, } from "./services/matcher.js";
import { createRagContext } from "./services/ragContext.js";
import { registerRagRoutes } from "./routes/ragRoutes.js";
import { rebuildIndex } from "./services/rag/indexer.js";

function decodeUploadFilename(name) {
    const raw = String(name || "upload").trim() || "upload";
    try {
        const decoded = Buffer.from(raw, "latin1").toString("utf8").trim();
        if (!decoded)
            return raw;
        const rawHasCjk = /[\u4e00-\u9fff]/.test(raw);
        const decodedHasCjk = /[\u4e00-\u9fff]/.test(decoded);
        if (decodedHasCjk && !rawHasCjk)
            return decoded;
        if (/[\u00c0-\u00ff]{2,}/.test(raw) && decodedHasCjk)
            return decoded;
    }
    catch {
        /* ignore */
    }
    return raw;
}

function validateKbId(ctx, kbId) {
    const kid = (kbId || "").trim();
    if (!kid)
        throw httpError(400, "kb_id 不能为空");
    if (!ctx.kbStore.get(kid))
        throw httpError(404, "kb_id 不存在");
    return kid;
}
function httpError(status, detail) {
    const e = new Error(detail);
    e.status = status;
    e.detail = detail;
    return e;
}
function llmForProfile(settings, profile) {
    return new LLMClient(settings).withCredentials({
        api_base_url: profile.api_base_url,
        api_key: profile.api_key,
        enable_thinking: profile.enable_thinking ?? null,
    });
}
function llmForSlot(settings, modelsStore, slot) {
    const cfg = modelsStore.getSlot(slot);
    return new LLMClient(settings).withCredentials({
        api_base_url: cfg.api_base_url,
        api_key: cfg.api_key,
        enable_thinking: cfg.enable_thinking ?? null,
    });
}
function normalizeImportRanges(ranges) {
    const out = [];
    if (!Array.isArray(ranges))
        return out;
    for (const r of ranges) {
        if (!Array.isArray(r) || r.length < 2)
            continue;
        const s = Number(r[0]);
        const e = Number(r[1]);
        if (s >= 1 && e >= s)
            out.push([s, e]);
    }
    return out;
}
function firstKbId(ctx) {
    const ids = Object.keys(ctx.kbStore.getAll()).sort((a, b) => {
        if (/^\d+$/.test(a) && /^\d+$/.test(b))
            return parseInt(a, 10) - parseInt(b, 10);
        return a.localeCompare(b);
    });
    return ids[0] ?? "";
}
export async function createAppContext() {
    const settings = loadSettings();
    const kbStore = new KbStore();
    await kbStore.init();
    const modelsStore = ModelsStore.fromSettings(settings);
    await modelsStore.init();
    const opLog = new OperationLog();
    let cache;
    const promptsStore = PromptsStore.open(() => { void cache?.reloadAll(); });
    await promptsStore.init();
    cache = new QuestionsCache(kbStore, settings.confidenceTopK, promptsStore);
    await cache.loadAll();
    const matchProfilesStore = MatchProfilesStore.open(modelsStore);
    await matchProfilesStore.init();
    const ragCtx = await createRagContext({ settings, kbStore, opLog });
    return { settings, kbStore, cache, modelsStore, matchProfilesStore, promptsStore, opLog, ragCtx };
}
export function createApp(ctx, clientDist) {
    const app = express();
    app.use(express.json({ limit: "50mb" }));
    const upload = multer({ storage: multer.memoryStorage() });
    app.use((err, _req, res, next) => {
        if (err.status)
            return res.status(err.status).json({ detail: err.detail ?? err.message });
        next(err);
    });
    const resolveProfile = (profileId = "") => {
        try {
            return ctx.matchProfilesStore.get(profileId);
        }
        catch (e) {
            throw httpError(400, e instanceof Error ? e.message : String(e));
        }
    };
    app.get("/health", (_req, res) => res.json({ status: "ok" }));
    registerRagRoutes(app, ctx, ctx.ragCtx);
    app.post("/ask/confidence", async (req, res) => {
        try {
            const question = String(req.body.question ?? "").trim();
            if (!question)
                throw httpError(400, "question 不能为空");
            const kbId = validateKbId(ctx, req.body.kb_id);
            const profile = resolveProfile(req.body.match_profile_id);
            const [, , , , resp] = await runConfidenceMatch({
                question,
                kbId,
                topK: Math.max(1, Math.min(20, Number(req.body.top_k ?? 5))),
                cache: ctx.cache,
                llm: llmForProfile(ctx.settings, profile),
                settings: ctx.settings,
                matchModel: profile.model,
                maxTokens: profile.max_tokens,
                temperature: profile.temperature,
            });
            res.json(resp);
        }
        catch (e) {
            if (e instanceof LLMError)
                return res.status(502).json({ detail: e.message });
            if (e.status)
                return res.status(e.status).json({ detail: e.detail });
            throw e;
        }
    });
    app.post("/ask/confidence/stream", async (req, res) => {
        const question = String(req.body.question ?? "").trim();
        if (!question)
            return res.status(400).json({ detail: "question 不能为空" });
        let kbId;
        try {
            kbId = validateKbId(ctx, req.body.kb_id);
        }
        catch (e) {
            return res.status(e.status).json({ detail: e.detail });
        }
        const topK = Math.max(1, Math.min(20, Number(req.body.top_k ?? 5)));
        const profile = resolveProfile(req.body.match_profile_id);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), ctx.settings.debugRequestTimeoutS * 1000);
        const logQueue = [];
        const box = { matchResult: null, workerError: null, done: false };
        const worker = (async () => {
            const sink = new AskLogSink((line, kind) => logQueue.push(["log", line, kind]), ctx.opLog, "debug", kbId);
            try {
                sink.log("[step] POST /ask/confidence/stream 收到请求", "step");
                box.matchResult = await runConfidenceMatch({
                    question,
                    kbId,
                    topK,
                    cache: ctx.cache,
                    llm: llmForProfile(ctx.settings, profile),
                    settings: ctx.settings,
                    logSink: sink,
                    matchModel: profile.model,
                    maxTokens: profile.max_tokens,
                    temperature: profile.temperature,
                    abortSignal: ac.signal,
                });
            }
            catch (e) {
                box.workerError = e instanceof Error ? e : new Error(String(e));
            }
            finally {
                box.done = true;
            }
        })();
        while (!box.done || logQueue.length) {
            while (logQueue.length) {
                const [, line, kind] = logQueue.shift();
                res.write(sseEvent("log", { line, kind }));
            }
            if (!box.done)
                await new Promise((r) => setTimeout(r, 50));
        }
        clearTimeout(timeout);
        await worker;
        if (box.workerError) {
            const timedOut = ac.signal.aborted || box.workerError.message.includes("超时");
            res.write(sseEvent("error", { detail: box.workerError.message, timed_out: timedOut }));
            return res.end();
        }
        if (!box.matchResult)
            return res.end();
        const [match, , , messagesDict, resp] = box.matchResult;
        res.write(sseEvent("candidates", {
            raw_output: match.raw_output,
            candidates: match.candidates,
            enabled_count: (await ctx.cache.getEnabledCount(kbId)),
            messages: messagesDict,
        }));
        res.write(sseEvent("done", {
            question: resp.question,
            kb_id: resp.kb_id,
            match: resp.match,
            answer: resp.answer,
            answers: resp.answers,
            timings: resp.timings,
            cache_hit: resp.cache_hit,
        }));
        res.end();
    });
    app.get("/knowledge-bases", async (_req, res) => {
        const items = [];
        for (const [kb_id, cfg] of Object.entries(ctx.kbStore.getAll())) {
            let enabled_count = 0;
            try {
                enabled_count = await ctx.cache.getEnabledCount(kb_id);
            }
            catch {
                enabled_count = ctx.cache.getIndex(kb_id)?.enabledItems.length ?? 0;
            }
            items.push({ kb_id, ...cfg, enabled_count });
        }
        res.json({ items });
    });
    app.post("/knowledge-bases", async (req, res) => {
        const kbId = String(req.body.kb_id ?? "").trim() || (await ctx.kbStore.nextAvailableKbId());
        const name = String(req.body.name ?? "").trim();
        try {
            const cfg = await ctx.kbStore.createKb(kbId, name);
            fs.mkdirSync(kbDirPath(ctx.settings.filesRoot, kbId), { recursive: true });
            fs.mkdirSync(kbAssetsDirPath(ctx.settings.filesRoot, kbId), { recursive: true });
            await ctx.cache.loadKb(kbId);
            res.json({ kb_id: kbId, ...cfg });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.get("/knowledge-bases/:kbId", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const cfg = ctx.kbStore.get(kid);
            res.json({ kb_id: kid, ...cfg, enabled_count: await ctx.cache.getEnabledCount(kid) });
        }
        catch (e) {
            res.status(e.status).json({ detail: e.detail });
        }
    });
    app.delete("/knowledge-bases/:kbId", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const cfg = await ctx.kbStore.deleteKb(kid);
            ctx.cache.evictKb(kid);
            ctx.kbStore.deleteKbFiles(kid, ctx.settings.filesRoot);
            res.json({ kb_id: kid, ...cfg });
        }
        catch (e) {
            res.status(404).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/knowledge-bases/:kbId/rename", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const cfg = await ctx.kbStore.renameKb(kid, String(req.body.name ?? "").trim());
            res.json({ kb_id: kid, ...cfg });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.get("/knowledge-bases/:kbId/confidence-prompt-preview", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const topK = Math.max(1, Math.min(20, Number(req.query.top_k ?? 5)));
            const [confRules, systemPrompt, enabledCount] = await ctx.cache.previewConfidenceSystemPrompt(kid, topK);
            res.json({
                kb_id: kid,
                confidence_match_prompt: confRules,
                system_prompt: systemPrompt,
                enabled_count: enabledCount,
            });
        }
        catch (e) {
            res.status(404).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/knowledge-bases/:kbId/reload", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const idx = await ctx.cache.reloadKb(kid);
            res.json({ kb_id: kid, loaded_at: idx.loadedAt, enabled_count: idx.enabledItems.length });
        }
        catch (e) {
            res.status(404).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/knowledge-bases/:kbId/import/from-rag", async (req, res) => {
        try {
            const llmKbId = validateKbId(ctx, req.params.kbId);
            const ragKbId = String(req.body.rag_kb_id ?? "").trim();
            if (!ragKbId)
                throw httpError(400, "rag_kb_id 必填");
            const result = await importRagFaqToLlm(ctx, llmKbId, ragKbId, {
                append: req.body.append !== false,
                replace: Boolean(req.body.replace),
            });
            ctx.opLog.append({
                module: "manage",
                action: "import-from-rag",
                kb_id: llmKbId,
                detail: `from rag ${ragKbId}, ${result.imported} items`,
            });
            res.json({ ok: true, ...result });
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? (e instanceof Error ? e.message : String(e)) });
        }
    });
    app.get("/knowledge-bases/:kbId/questions", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(await ctx.cache.store(kid).getDocument());
        }
        catch (e) {
            res.status(404).json({ detail: e.detail ?? String(e) });
        }
    });
    app.put("/knowledge-bases/:kbId/questions", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const doc = await ctx.cache.store(kid).replaceAll(Number(req.body.version ?? 1), req.body.items ?? []);
            await ctx.cache.reloadKb(kid);
            res.json(doc);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/knowledge-bases/:kbId/questions/items", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const store = ctx.cache.store(kid);
            if (await store.getItem(String(req.body.id ?? "")))
                throw httpError(400, "item id 已存在");
            const item = await store.upsertItem(req.body);
            await ctx.cache.reloadKb(kid);
            ctx.opLog.append({ module: "manage", action: "create_item", kb_id: kid, detail: `item ${req.body.id}` });
            res.json(item);
        }
        catch (e) {
            res.status(e.status ?? 400).json({ detail: e.detail ?? String(e) });
        }
    });
    app.put("/knowledge-bases/:kbId/questions/items/:itemId", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            if (req.body.id !== req.params.itemId)
                throw httpError(400, "路径 item_id 与 body.id 不一致");
            const store = ctx.cache.store(kid);
            if (!(await store.getItem(req.params.itemId)))
                throw httpError(404, "item_id 不存在");
            const item = await store.upsertItem(req.body);
            await ctx.cache.reloadKb(kid);
            ctx.opLog.append({ module: "manage", action: "update_item", kb_id: kid, detail: `item ${req.body.id}` });
            res.json(item);
        }
        catch (e) {
            res.status(e.status ?? 400).json({ detail: e.detail ?? String(e) });
        }
    });
    app.delete("/knowledge-bases/:kbId/questions/items/:itemId", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const item = await ctx.cache.store(kid).deleteItem(req.params.itemId);
            await ctx.cache.reloadKb(kid);
            ctx.opLog.append({ module: "manage", action: "delete_item", kb_id: kid, detail: `item ${req.params.itemId}` });
            res.json(item);
        }
        catch (e) {
            res.status(404).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.get("/preview-asset", (req, res) => {
        try {
            const kid = validateKbId(ctx, String(req.query.kb_id ?? ""));
            let r = String(req.query.ref ?? "").trim().replace(/\\/g, "/");
            if (r.startsWith("../"))
                r = r.slice(3);
            if (r.startsWith("assets/"))
                r = r.slice(7);
            if (r.includes(".."))
                throw httpError(400, "非法 ref");
            const base = path.resolve(kbAssetsDirPath(ctx.settings.filesRoot, kid));
            const assetPath = path.resolve(path.join(base, r));
            if (!assetPath.startsWith(base))
                throw httpError(400, "非法 ref");
            if (!fs.existsSync(assetPath))
                throw httpError(404, "资源不存在");
            res.sendFile(assetPath);
        }
        catch (e) {
            res.status(e.status ?? 400).json({ detail: e.detail ?? String(e) });
        }
    });
    app.get("/documents/preview-asset", (req, res) => {
        try {
            let r = String(req.query.ref ?? "").trim().replace(/\\/g, "/");
            if (r.startsWith("../"))
                r = r.slice(3);
            if (r.startsWith("assets/"))
                r = r.slice(7);
            if (r.includes(".."))
                throw httpError(400, "非法 ref");
            const base = path.resolve(documentsAssetsDirPath(ctx.settings.filesRoot));
            const assetPath = path.resolve(path.join(base, r));
            if (!assetPath.startsWith(base))
                throw httpError(400, "非法 ref");
            if (!fs.existsSync(assetPath))
                throw httpError(404, "资源不存在");
            res.sendFile(assetPath);
        }
        catch (e) {
            res.status(e.status ?? 400).json({ detail: e.detail ?? String(e) });
        }
    });
    app.get("/logs", async (req, res) => {
        const items = await ctx.opLog.listEntries({
            limit: Number(req.query.limit ?? 500),
            modules: String(req.query.modules ?? req.query.module ?? ""),
            kb_id: String(req.query.kb_id ?? ""),
            level: String(req.query.level ?? ""),
        });
        res.json({ items });
    });
    app.get("/logs/stream", (req, res) => {
        let last = String(req.query.since ?? "");
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.flushHeaders?.();
        const interval = setInterval(() => {
            void (async () => {
                const batch = await ctx.opLog.listEntries({ since: last, limit: 500 });
                for (const entry of batch) {
                    if (entry.ts > last) {
                        res.write(sseEvent("log", entry));
                        last = entry.ts;
                    }
                }
            })();
        }, 1000);
        req.on("close", () => clearInterval(interval));
    });
    app.get("/settings/prompts", async (req, res) => {
        const gp = ctx.promptsStore.get();
        const previewKb = String(req.query.kb_id ?? "").trim() || firstKbId(ctx);
        const topK = ctx.settings.confidenceTopK;
        const defaults = allDefaultPrompts(topK);
        let confPreview = "";
        let confQuestionsSection = "";
        let enabledCount = 0;
        if (previewKb) {
            try {
                let idx = ctx.cache.getIndex(previewKb);
                if (!idx)
                    idx = await ctx.cache.loadKb(previewKb);
                enabledCount = idx.enabledItems.length;
                confQuestionsSection = buildQuestionListSection(idx.enabledItems);
                let rules = gp.confidence_match_prompt.trim() || defaultConfidenceMatchPrompt(topK);
                if (rules.includes("{top_k}"))
                    rules = rules.replace("{top_k}", String(topK));
                confPreview = `${rules}\n\n${confQuestionsSection}`;
            }
            catch {
                /* ignore */
            }
        }
        res.json({
            confidence_match_prompt: gp.confidence_match_prompt,
            faq_generation_prompt: gp.faq_generation_prompt,
            pdf_vlm_prompt: gp.pdf_vlm_prompt,
            updated_at: gp.updated_at,
            preview_kb_id: previewKb,
            preview_top_k: topK,
            defaults,
            confidence_system_preview: confPreview,
            confidence_questions_section: confQuestionsSection,
            faq_system_preview: gp.faq_generation_prompt.trim() || defaults.faq_generation_prompt,
            pdf_vlm_system_preview: gp.pdf_vlm_prompt.trim() || defaults.pdf_vlm_prompt,
            enabled_count: enabledCount,
        });
    });
    app.put("/settings/prompts", async (req, res) => {
        const gp = await ctx.promptsStore.set({
            confidence_match_prompt: "confidence_match_prompt" in req.body ? req.body.confidence_match_prompt : undefined,
            faq_generation_prompt: "faq_generation_prompt" in req.body ? req.body.faq_generation_prompt : undefined,
            pdf_vlm_prompt: "pdf_vlm_prompt" in req.body ? req.body.pdf_vlm_prompt : undefined,
        });
        ctx.opLog.append({ module: "settings", action: "update_prompts", detail: "更新问答模型提示词" });
        res.json({ ...gp, defaults: allDefaultPrompts(ctx.settings.confidenceTopK) });
    });
    app.get("/settings/match-profiles", (_req, res) => {
        res.json({
            default_id: ctx.matchProfilesStore.getDefaultId(),
            profiles: ctx.matchProfilesStore.listProfiles(false),
        });
    });
    app.put("/settings/match-profiles", async (req, res) => {
        const updated = await ctx.matchProfilesStore.updateAll(req.body);
        ctx.opLog.append({ module: "settings", action: "update_match_profiles", detail: "更新问答模型配置" });
        res.json(updated);
    });
    app.get("/settings/models", (_req, res) => {
        res.json({ slots: ctx.modelsStore.getAll(false) });
    });
    app.put("/settings/models", async (req, res) => {
        const slots = req.body.slots && typeof req.body.slots === "object" ? req.body.slots : req.body;
        const updated = await ctx.modelsStore.updateAll(slots ?? {});
        ctx.opLog.append({ module: "settings", action: "update_models", detail: "更新模型配置" });
        res.json({ slots: updated });
    });
    app.get("/knowledge-bases/:kbId/recall-tests", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(await ctx.ragCtx.getLlmRecallTestsStore(kid).getDocument());
        }
        catch (e) {
            res.status(404).json({ detail: e.detail ?? String(e) });
        }
    });
    app.put("/knowledge-bases/:kbId/recall-tests", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const doc = await ctx.ragCtx.getLlmRecallTestsStore(kid).replaceAll(req.body);
            ctx.opLog.append({ module: "debug", action: "save_recall_tests", kb_id: kid, detail: `${(req.body.items ?? []).length} rows` });
            res.json(doc);
        }
        catch (e) {
            res.status(404).json({ detail: e.detail ?? String(e) });
        }
    });
    app.get("/markdown-files/tree", (_req, res) => {
        res.json(buildMarkdownFilesTree(ctx.settings.filesRoot));
    });
    app.get("/documents/capabilities", (_req, res) => {
        res.json(listCapabilitiesPayload());
    });
    app.get("/documents/preview-file", (req, res) => {
        try {
            const filePath = resolvePreviewFilePath(ctx.settings.filesRoot, String(req.query.path ?? ""));
            res.setHeader("Content-Type", "application/pdf");
            res.sendFile(filePath);
        }
        catch (e) {
            res.status(e.status ?? 400).json({ detail: e instanceof LLMError ? e.message : String(e) });
        }
    });
    app.get("/documents/excel-sheets", (req, res) => {
        try {
            const filename = path.basename(String(req.query.filename ?? "").trim());
            const sourcePath = documentsSourcePath(ctx.settings.filesRoot, filename);
            if (!fs.existsSync(sourcePath))
                return res.status(404).json({ detail: "源文件不存在" });
            res.json({ sheets: listExcelSheets(sourcePath) });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof LLMError ? e.message : String(e) });
        }
    });
    app.get("/markdown-files/content", async (req, res) => {
        try {
            res.json(await readDocumentContent(ctx.settings.filesRoot, String(req.query.path ?? "")));
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof LLMError ? e.message : String(e) });
        }
    });
    app.put("/markdown-files/content", (req, res) => {
        try {
            const rel = String(req.body.path ?? "").trim();
            if (!rel)
                throw httpError(400, "path 必填");
            const result = saveMarkdownContent(ctx.settings.filesRoot, rel, String(req.body.markdown ?? ""));
            ctx.opLog.append({ module: "files", action: "save", detail: rel });
            res.json(result);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof LLMError ? e.message : e.detail ?? String(e) });
        }
    });
    app.delete("/markdown-files", (req, res) => {
        try {
            const result = deleteDocumentFile(ctx.settings.filesRoot, String(req.query.path ?? ""));
            ctx.opLog.append({ module: "files", action: "delete", detail: String(req.query.path ?? "") });
            res.json(result);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof LLMError ? e.message : String(e) });
        }
    });
    app.put("/markdown-files/rename", (req, res) => {
        try {
            const rel = String(req.body.path ?? "").trim();
            if (!rel)
                throw httpError(400, "path 必填");
            const result = renameDocumentFile(ctx.settings.filesRoot, rel, String(req.body.name ?? ""));
            ctx.opLog.append({ module: "files", action: "rename", detail: `${rel} -> ${result.path}` });
            res.json(result);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof LLMError ? e.message : String(e) });
        }
    });
    app.post("/markdown-files", (req, res) => {
        try {
            const result = createModuleMarkdown(ctx.settings.filesRoot, String(req.body.name ?? ""), String(req.body.markdown ?? ""));
            ctx.opLog.append({ module: "files", action: "create", detail: result.path });
            res.json(result);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof LLMError ? e.message : String(e) });
        }
    });
    app.post("/documents/upload", upload.single("file"), (req, res) => {
        const file = req.file;
        if (!file)
            return res.status(400).json({ detail: "file 必填" });
        const name = decodeUploadFilename(file.originalname);
        if (!isAllowedSourceExtension(name)) {
            return res.status(400).json({ detail: "不支持的文件类型" });
        }
        const destDir = documentsSourcesDirPath(ctx.settings.filesRoot);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, path.basename(name));
        const overwrite = req.query.overwrite === "1"
            || req.query.overwrite === "true"
            || req.body?.overwrite === "1"
            || req.body?.overwrite === true;
        if (fs.existsSync(dest) && !overwrite) {
            return res.status(409).json({
                detail: `文件「${path.basename(dest)}」已存在`,
                filename: path.basename(dest),
                exists: true,
            });
        }
        fs.writeFileSync(dest, file.buffer);
        const kind = docFileKind(path.basename(dest), "sources");
        const file_type = formatFromFilename(path.basename(dest));
        const caps = capabilitiesForKind(kind);
        const meta = {
            filename: path.basename(dest),
            size: file.size,
            file_type,
            kind,
            capabilities: caps,
        };
        if (caps?.editable !== false && !["source_pdf", "source_docx", "source_xlsx", "source_xls", "source_csv"].includes(kind)) {
            try {
                meta.line_count = fs.readFileSync(dest, "utf-8").split(/\r?\n/).length;
            }
            catch {
                meta.line_count = 0;
            }
        }
        ctx.opLog.append({ module: "files", action: "upload", detail: `uploaded ${path.basename(dest)}` });
        res.json(meta);
    });
    app.post("/documents/extract/stream", async (req, res) => {
        const filename = String(req.body.filename ?? "").trim()
            || path.basename(String(req.body.path ?? "").trim());
        const ranges = normalizeImportRanges(req.body.ranges);
        const useVlmRefine = req.body.use_vlm_refine !== false;
        const sheetName = String(req.body.sheet_name ?? "").trim() || undefined;
        if (!filename)
            return res.status(400).json({ detail: "filename 必填" });
        if (!ranges.length)
            return res.status(400).json({ detail: "请指定有效页码或行范围" });
        let sourcePath;
        try {
            sourcePath = documentsSourcePath(ctx.settings.filesRoot, filename);
        }
        catch (e) {
            return res.status(400).json({ detail: e instanceof LLMError ? e.message : String(e) });
        }
        if (!fs.existsSync(sourcePath))
            return res.status(404).json({ detail: "源文件不存在" });
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        res.write(": connected\n\n");
        const flushSse = () => {
            if (typeof res.flush === "function")
                res.flush();
        };
        const keepAlive = setInterval(() => {
            if (!res.writableEnded) {
                res.write(": keepalive\n\n");
                flushSse();
            }
        }, 8000);
        const emitStep = (line) => {
            res.write(sseEvent("log", { line, kind: "step" }));
            flushSse();
            ctx.opLog.append({ module: "files", action: "step", detail: line, kind: "step" });
        };
        const forwardProgress = (msg) => {
            const line = String(msg ?? "").trim();
            if (line)
                emitStep(line);
        };
        let stagingRoot = null;
        try {
            emitStep("正在准备提取任务…");
            const fmt = detectSourceFormat(filename);
            const isPdf = fmt === "pdf";
            const isLineRange = ["md", "txt", "json", "html", "htm", "docx"].includes(fmt);
            const isExcel = ["xlsx", "xls", "csv"].includes(fmt);
            if (!isPdf && !isLineRange && !isExcel)
                throw new LLMError(`不支持的文件类型: ${fmt}`);
            const pdfVlmCfg = ctx.modelsStore.getSlot("pdf_vlm");
            const vlmPrompt = ctx.promptsStore.effectivePdfVlmPrompt();
            const multiRange = ranges.length > 1 && (isPdf || isLineRange);
            if (multiRange) {
                stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kr-extract-"));
                emitStep(`共 ${ranges.length} 段范围，将合并为单个 Markdown…`);
            }
            let combined = {};
            const extractParts = [];
            const allWarnings = [];
            const rangeList = isExcel ? [[1, 1]] : ranges;
            for (const [rangeStart, rangeEnd] of rangeList) {
                const rangeOutDir = multiRange
                    ? path.join(stagingRoot, `${isPdf ? "p" : "l"}${rangeStart}-${rangeEnd}`)
                    : undefined;
                if (rangeOutDir)
                    fs.mkdirSync(rangeOutDir, { recursive: true });
                let mergedMd;
                let moduleOut;
                let stats;
                if (isExcel) {
                    emitStep("开始转换 Excel 工作表…");
                    [mergedMd, moduleOut, stats] = await extractSourceToMarkdown({
                        filesRoot: ctx.settings.filesRoot,
                        sourcePath,
                        filename,
                        ranges: [[1, 1]],
                        sheetName,
                        onProgress: forwardProgress,
                        outputModulesDir: rangeOutDir,
                        settings: ctx.settings,
                        modelsStore: ctx.modelsStore,
                        promptsStore: ctx.promptsStore,
                        useVlmRefine,
                    });
                }
                else if (fmt === "docx") {
                    emitStep(`开始转换 Word 第 ${rangeStart}-${rangeEnd} 行…`);
                    [mergedMd, moduleOut, stats] = await extractSourceToMarkdown({
                        filesRoot: ctx.settings.filesRoot,
                        sourcePath,
                        filename,
                        ranges: [[rangeStart, rangeEnd]],
                        onProgress: forwardProgress,
                        outputModulesDir: rangeOutDir,
                        settings: ctx.settings,
                        modelsStore: ctx.modelsStore,
                        promptsStore: ctx.promptsStore,
                        useVlmRefine,
                    });
                }
                else if (isPdf) {
                    emitStep(`开始提取第 ${rangeStart}-${rangeEnd} 页…`);
                    [mergedMd, moduleOut, stats] = await extractPdfToMarkdown({
                        filesRoot: ctx.settings.filesRoot,
                        sourcePath,
                        pageStart: rangeStart,
                        pageEnd: rangeEnd,
                        vlmModel: pdfVlmCfg.model,
                        vlmSystemPrompt: vlmPrompt,
                        outputModulesDir: rangeOutDir,
                        onProgress: forwardProgress,
                    });
                }
                else {
                    if (["html", "htm"].includes(fmt) && useVlmRefine) {
                        emitStep(`开始转换 HTML 第 ${rangeStart}-${rangeEnd} 行…`);
                        [mergedMd, moduleOut, stats] = await extractSourceToMarkdown({
                            filesRoot: ctx.settings.filesRoot,
                            sourcePath,
                            filename,
                            ranges: [[rangeStart, rangeEnd]],
                            onProgress: forwardProgress,
                            outputModulesDir: rangeOutDir,
                            settings: ctx.settings,
                            modelsStore: ctx.modelsStore,
                            promptsStore: ctx.promptsStore,
                            useVlmRefine,
                        });
                    }
                    else {
                        [mergedMd, moduleOut, stats] = await extractMarkdownRange({
                            filesRoot: ctx.settings.filesRoot,
                            sourcePath,
                            lineStart: rangeStart,
                            lineEnd: rangeEnd,
                            outputModulesDir: rangeOutDir,
                            onProgress: forwardProgress,
                        });
                    }
                }
                if (stats.warnings?.length)
                    allWarnings.push(...stats.warnings);
                extractParts.push({
                    label: isPdf
                        ? `pages ${rangeStart}-${rangeEnd}`
                        : isExcel
                            ? `sheet ${sheetName || "default"}`
                            : `lines ${rangeStart}-${rangeEnd}`,
                    md: mergedMd,
                    modulePath: stats.module_path,
                    absPath: moduleOut,
                });
                combined = mergeExtractStats(combined, stats);
                if (isExcel)
                    break;
            }
            if (multiRange) {
                emitStep(`正在合并 ${ranges.length} 段为单个 Markdown…`);
            }
            const result = finalizeCombinedExtract(
                ctx.settings.filesRoot,
                filename,
                isExcel ? [[1, 1]] : ranges,
                isPdf,
                extractParts,
                combined,
            );
            if (allWarnings.length)
                result.warnings = [...new Set(allWarnings)];
            emitStep(`已写入 ${result.path}`);
            res.write(sseEvent("done", result));
            flushSse();
        }
        catch (e) {
            res.write(sseEvent("error", { detail: e instanceof Error ? e.message : String(e) }));
        }
        finally {
            clearInterval(keepAlive);
            if (stagingRoot && fs.existsSync(stagingRoot))
                fs.rmSync(stagingRoot, { recursive: true, force: true });
        }
        res.end();
    });
    app.post("/knowledge-bases/:kbId/import/generate-questions", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const answerMd = String(req.body.answer_md ?? "");
            const importCfg = ctx.modelsStore.getSlot("import");
            const llm = llmForSlot(ctx.settings, ctx.modelsStore, "import");
            const faqPrompt = ctx.promptsStore.effectiveFaqPrompt();
            const [item, usage] = await generateFaqQuestionsOnly(answerMd, llm, importCfg.model, faqPrompt);
            res.json({
                question: item.question,
                variants: item.variants ?? [],
                tokens: usage,
            });
        }
        catch (e) {
            res.status(e instanceof LLMError ? 502 : 400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/knowledge-bases/:kbId/import/commit", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
            const append = Boolean(req.body.append);
            let targets = req.body.targets;
            if (!Array.isArray(targets) || !targets.length)
                targets = ["llm"];
            targets = targets.filter((t) => t === "llm" || t === "rag");
            if (!targets.length)
                throw httpError(400, "targets 须包含 llm 或 rag");

            const results = { llm: 0, rag: 0, kb_id: kid, items: [] };

            const assignAndMerge = async (store, existing) => {
                let startId = 1;
                if (existing.length) {
                    const nums = existing.map((i) => parseInt(String(i.id).replace(/^q/, ""), 10)).filter((n) => !Number.isNaN(n));
                    startId = nums.length ? Math.max(...nums) + 1 : 1;
                }
                const withIds = assignQuestionIds(rawItems, startId);
                if (append) {
                    for (const item of withIds)
                        await store.upsertItem(item);
                }
                else {
                    await store.replaceAll(1, [...existing.map((i) => ({ ...i })), ...withIds]);
                }
                return withIds;
            };

            if (targets.includes("llm")) {
                const store = ctx.cache.store(kid);
                const existing = (await store.getDocument()).items;
                const withIds = await assignAndMerge(store, existing);
                await ctx.cache.reloadKb(kid);
                results.llm = withIds.length;
                results.items = withIds;
                ctx.opLog.append({ module: "generate", action: "commit-llm", kb_id: kid, detail: `imported ${withIds.length} items` });
            }

            if (targets.includes("rag")) {
                const ragKid = String(req.body.rag_kb_id ?? kid).trim();
                if (!ctx.ragCtx.ragKbStore.get(ragKid))
                    throw httpError(404, `RAG 知识库 ${ragKid} 不存在`);
                const ragStore = ctx.ragCtx.getRagQuestionsStore(ragKid);
                const existing = (await ragStore.getDocument()).items;
                const withIds = await assignAndMerge(ragStore, existing);
                results.rag = withIds.length;
                if (!results.items.length)
                    results.items = withIds;
                if (req.body.auto_rebuild_rag !== false) {
                    try {
                        await rebuildIndex(ragKid, ctx.ragCtx);
                    }
                    catch (err) {
                        console.warn(`[import] rag rebuild failed: ${err}`);
                    }
                }
                ctx.opLog.append({ module: "generate", action: "commit-rag", kb_id: ragKid, detail: `imported ${withIds.length} items` });
            }

            res.json(results);
        }
        catch (e) {
            res.status(e.status || 400).json({ detail: e.detail ?? (e instanceof Error ? e.message : String(e)) });
        }
    });
    // Static: legacy assets (manual.md) + React production build
    const legacyWeb = path.join(APP_ROOT, "_legacy", "web");
    if (fs.existsSync(legacyWeb)) {
        app.use("/static", express.static(legacyWeb));
    }
    const clientPublic = path.join(APP_ROOT, "client", "public");
    if (fs.existsSync(clientPublic)) {
        app.use("/static", express.static(clientPublic));
    }
    const dist = clientDist ?? path.join(APP_ROOT, "client", "dist");
    if (fs.existsSync(dist)) {
        app.use(express.static(dist));
        app.get("*", (req, res, next) => {
            if (req.path.startsWith("/api") || req.path.includes("."))
                return next();
            res.sendFile(path.join(dist, "index.html"));
        });
    }
    else if (fs.existsSync(path.join(legacyWeb, "index.html"))) {
        app.get("/", (_req, res) => {
            res.sendFile(path.join(legacyWeb, "index.html"));
        });
    }
    return app;
}
