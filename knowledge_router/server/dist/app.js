import express from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { APP_ROOT, loadSettings } from "./config.js";
import { KbStore } from "./services/kbStore.js";
import { QuestionsCache } from "./services/questionsCache.js";
import { ModelsStore } from "./services/modelsStore.js";
import { MatchProfilesStore } from "./services/matchProfilesStore.js";
import { PromptsStore } from "./services/promptsStore.js";
import { OperationLog } from "./services/operationLog.js";
import { LLMClient, LLMError } from "./services/llmClient.js";
import { AskLogSink, runConfidenceMatch, sseEvent, } from "./services/confidenceMatch.js";
import { kbAssetsDirPath, kbDirPath, questionsJsonPath, recallTestsJsonPath, documentsAssetsDirPath, documentsSourcesDirPath, } from "./services/paths.js";
import { buildMarkdownFilesTree, readMarkdownContent, saveMarkdownContent, deleteDocumentFile, renameDocumentFile, createModuleMarkdown, documentsSourcePath, } from "./services/markdownFiles.js";
import { extractMarkdownRange, extractPdfToMarkdown, mergeExtractStats, } from "./services/fileProcessor.js";
import { assignQuestionIds, generateFaqQuestionsOnly } from "./services/questionsImport.js";
import { allDefaultPrompts } from "./services/promptDefaults.js";
import { buildQuestionListSection, defaultConfidenceMatchPrompt, } from "./services/matcher.js";
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
export function createAppContext() {
    const settings = loadSettings();
    const kbStore = new KbStore(settings.kbConfigPath);
    const modelsStore = ModelsStore.fromSettings(settings);
    const opLog = new OperationLog(5000, path.join(settings.dataRoot, "logs", "operations.jsonl"));
    const promptsPath = path.join(settings.dataRoot, "config", "prompts.json");
    let cache;
    const promptsStore = PromptsStore.open(promptsPath, () => cache?.reloadAll());
    cache = new QuestionsCache(kbStore, settings.filesRoot, settings.confidenceTopK, promptsStore);
    cache.loadAll();
    const profilesPath = path.join(settings.dataRoot, "config", "match_profiles.json");
    const matchProfilesStore = MatchProfilesStore.open(profilesPath, modelsStore);
    return { settings, kbStore, cache, modelsStore, matchProfilesStore, promptsStore, opLog };
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
            enabled_count: ctx.cache.getEnabledCount(kbId),
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
    app.get("/knowledge-bases", (_req, res) => {
        const items = Object.entries(ctx.kbStore.getAll()).map(([kb_id, cfg]) => ({
            kb_id,
            ...cfg,
            enabled_count: ctx.cache.getIndex(kb_id)?.enabledItems.length ?? 0,
        }));
        res.json({ items });
    });
    app.post("/knowledge-bases", (req, res) => {
        const kbId = String(req.body.kb_id ?? "").trim() || ctx.kbStore.nextAvailableKbId();
        const name = String(req.body.name ?? "").trim();
        try {
            const cfg = ctx.kbStore.createKb(kbId, name);
            fs.mkdirSync(kbDirPath(ctx.settings.filesRoot, kbId), { recursive: true });
            fs.mkdirSync(kbAssetsDirPath(ctx.settings.filesRoot, kbId), { recursive: true });
            const qpath = questionsJsonPath(ctx.settings.filesRoot, kbId);
            if (!fs.existsSync(qpath)) {
                fs.writeFileSync(qpath, JSON.stringify({ version: 1, items: [] }, null, 2), "utf-8");
            }
            ctx.cache.loadKb(kbId);
            res.json({ kb_id: kbId, ...cfg });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.get("/knowledge-bases/:kbId", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const cfg = ctx.kbStore.get(kid);
            res.json({ kb_id: kid, ...cfg, enabled_count: ctx.cache.getEnabledCount(kid) });
        }
        catch (e) {
            res.status(e.status).json({ detail: e.detail });
        }
    });
    app.delete("/knowledge-bases/:kbId", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const cfg = ctx.kbStore.deleteKb(kid);
            ctx.cache.evictKb(kid);
            ctx.kbStore.deleteKbFiles(kid, ctx.settings.filesRoot);
            res.json({ kb_id: kid, ...cfg });
        }
        catch (e) {
            res.status(404).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/knowledge-bases/:kbId/rename", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const cfg = ctx.kbStore.renameKb(kid, String(req.body.name ?? "").trim());
            res.json({ kb_id: kid, ...cfg });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.get("/knowledge-bases/:kbId/confidence-prompt-preview", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const topK = Math.max(1, Math.min(20, Number(req.query.top_k ?? 5)));
            const [confRules, systemPrompt, enabledCount] = ctx.cache.previewConfidenceSystemPrompt(kid, topK);
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
    app.post("/knowledge-bases/:kbId/reload", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const idx = ctx.cache.reloadKb(kid);
            res.json({ kb_id: kid, loaded_at: idx.loadedAt, enabled_count: idx.enabledItems.length });
        }
        catch (e) {
            res.status(404).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.get("/knowledge-bases/:kbId/questions", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(ctx.cache.store(kid).getDocument());
        }
        catch (e) {
            res.status(404).json({ detail: e.detail ?? String(e) });
        }
    });
    app.put("/knowledge-bases/:kbId/questions", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const doc = ctx.cache.store(kid).replaceAll(Number(req.body.version ?? 1), req.body.items ?? []);
            ctx.cache.reloadKb(kid);
            res.json(doc);
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/knowledge-bases/:kbId/questions/items", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const store = ctx.cache.store(kid);
            if (store.getItem(String(req.body.id ?? "")))
                throw httpError(400, "item id 已存在");
            const item = store.upsertItem(req.body);
            ctx.cache.reloadKb(kid);
            ctx.opLog.append({ module: "manage", action: "create_item", kb_id: kid, detail: `item ${req.body.id}` });
            res.json(item);
        }
        catch (e) {
            res.status(e.status ?? 400).json({ detail: e.detail ?? String(e) });
        }
    });
    app.put("/knowledge-bases/:kbId/questions/items/:itemId", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            if (req.body.id !== req.params.itemId)
                throw httpError(400, "路径 item_id 与 body.id 不一致");
            const store = ctx.cache.store(kid);
            if (!store.getItem(req.params.itemId))
                throw httpError(404, "item_id 不存在");
            const item = store.upsertItem(req.body);
            ctx.cache.reloadKb(kid);
            ctx.opLog.append({ module: "manage", action: "update_item", kb_id: kid, detail: `item ${req.body.id}` });
            res.json(item);
        }
        catch (e) {
            res.status(e.status ?? 400).json({ detail: e.detail ?? String(e) });
        }
    });
    app.delete("/knowledge-bases/:kbId/questions/items/:itemId", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const item = ctx.cache.store(kid).deleteItem(req.params.itemId);
            ctx.cache.reloadKb(kid);
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
    app.get("/logs", (req, res) => {
        const items = ctx.opLog.listEntries({
            limit: Number(req.query.limit ?? 500),
            module: String(req.query.module ?? ""),
            kb_id: String(req.query.kb_id ?? ""),
            level: String(req.query.level ?? ""),
        });
        res.json({ items });
    });
    app.delete("/logs", (_req, res) => {
        const n = ctx.opLog.clear();
        ctx.opLog.append({ module: "logs", action: "clear", detail: `cleared ${n} entries` });
        res.json({ cleared: n });
    });
    app.get("/logs/stream", (req, res) => {
        let last = String(req.query.since ?? "");
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.flushHeaders?.();
        const interval = setInterval(() => {
            const batch = ctx.opLog.listEntries({ limit: 500 });
            for (const entry of batch) {
                if (entry.ts > last) {
                    res.write(sseEvent("log", entry));
                    last = entry.ts;
                }
            }
        }, 1000);
        req.on("close", () => clearInterval(interval));
    });
    app.get("/settings/prompts", (req, res) => {
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
                    idx = ctx.cache.loadKb(previewKb);
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
    app.put("/settings/prompts", (req, res) => {
        const gp = ctx.promptsStore.set({
            confidence_match_prompt: "confidence_match_prompt" in req.body ? req.body.confidence_match_prompt : undefined,
            faq_generation_prompt: "faq_generation_prompt" in req.body ? req.body.faq_generation_prompt : undefined,
            pdf_vlm_prompt: "pdf_vlm_prompt" in req.body ? req.body.pdf_vlm_prompt : undefined,
        });
        ctx.opLog.append({ module: "settings", action: "update_prompts", detail: "更新回答模型提示词" });
        res.json({ ...gp, defaults: allDefaultPrompts(ctx.settings.confidenceTopK) });
    });
    app.get("/settings/match-profiles", (_req, res) => {
        res.json({
            default_id: ctx.matchProfilesStore.getDefaultId(),
            profiles: ctx.matchProfilesStore.listProfiles(false),
        });
    });
    app.put("/settings/match-profiles", (req, res) => {
        const updated = ctx.matchProfilesStore.updateAll(req.body);
        ctx.opLog.append({ module: "settings", action: "update_match_profiles", detail: "更新回答模型配置" });
        res.json(updated);
    });
    app.get("/settings/models", (_req, res) => {
        res.json({ slots: ctx.modelsStore.getAll(false) });
    });
    app.put("/settings/models", (req, res) => {
        const slots = req.body.slots && typeof req.body.slots === "object" ? req.body.slots : req.body;
        const updated = ctx.modelsStore.updateAll(slots ?? {});
        ctx.opLog.append({ module: "settings", action: "update_models", detail: "更新模型配置" });
        res.json({ slots: updated });
    });
    app.get("/knowledge-bases/:kbId/recall-tests", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const p = recallTestsJsonPath(ctx.settings.filesRoot, kid);
            if (!fs.existsSync(p))
                return res.json({ items: [] });
            res.json(JSON.parse(fs.readFileSync(p, "utf-8")));
        }
        catch (e) {
            res.status(404).json({ detail: e.detail ?? String(e) });
        }
    });
    app.put("/knowledge-bases/:kbId/recall-tests", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const p = recallTestsJsonPath(ctx.settings.filesRoot, kid);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(req.body, null, 2), "utf-8");
            ctx.opLog.append({ module: "debug", action: "save_recall_tests", kb_id: kid, detail: `${(req.body.items ?? []).length} rows` });
            res.json(req.body);
        }
        catch (e) {
            res.status(404).json({ detail: e.detail ?? String(e) });
        }
    });
    app.get("/markdown-files/tree", (_req, res) => {
        res.json(buildMarkdownFilesTree(ctx.settings.filesRoot));
    });
    app.get("/markdown-files/content", (req, res) => {
        try {
            res.json(readMarkdownContent(ctx.settings.filesRoot, String(req.query.path ?? "")));
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
        const name = (file.originalname || "upload").trim();
        if (!name.toLowerCase().endsWith(".pdf") && !name.toLowerCase().endsWith(".md")) {
            return res.status(400).json({ detail: "仅支持 .pdf 或 .md 文件" });
        }
        const destDir = documentsSourcesDirPath(ctx.settings.filesRoot);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, path.basename(name));
        fs.writeFileSync(dest, file.buffer);
        const meta = { filename: path.basename(dest), size: file.size };
        if (dest.toLowerCase().endsWith(".md")) {
            meta.line_count = fs.readFileSync(dest, "utf-8").split(/\r?\n/).length;
            meta.file_type = "md";
        }
        else {
            meta.file_type = "pdf";
        }
        ctx.opLog.append({ module: "files", action: "upload", detail: `uploaded ${path.basename(dest)}` });
        res.json(meta);
    });
    app.post("/documents/extract/stream", async (req, res) => {
        const filename = String(req.body.filename ?? "").trim();
        const ranges = normalizeImportRanges(req.body.ranges);
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
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.flushHeaders?.();
        res.write(": connected\n\n");
        const emit = (line, kind = "log") => {
            res.write(sseEvent("log", { line, kind }));
            ctx.opLog.append({ module: "files", action: "step", detail: line, kind: "step" });
        };
        try {
            emit("[step] 正在准备提取任务…", "step");
            const isPdf = filename.toLowerCase().endsWith(".pdf");
            const isMd = filename.toLowerCase().endsWith(".md");
            if (!isPdf && !isMd)
                throw new LLMError("仅支持 PDF 或 Markdown 文件导入");
            const pdfVlmCfg = ctx.modelsStore.getSlot("pdf_vlm");
            const vlmPrompt = ctx.promptsStore.effectivePdfVlmPrompt();
            let combined = {};
            for (const [rangeStart, rangeEnd] of ranges) {
                if (isMd) {
                    const [, , stats] = await extractMarkdownRange({
                        filesRoot: ctx.settings.filesRoot,
                        sourcePath,
                        lineStart: rangeStart,
                        lineEnd: rangeEnd,
                        onProgress: (msg) => emit(msg, "log"),
                    });
                    combined = mergeExtractStats(combined, stats);
                }
                else {
                    const [, , stats] = await extractPdfToMarkdown({
                        filesRoot: ctx.settings.filesRoot,
                        sourcePath,
                        pageStart: rangeStart,
                        pageEnd: rangeEnd,
                        vlmModel: pdfVlmCfg.model,
                        vlmSystemPrompt: vlmPrompt,
                        onProgress: (msg) => emit(msg, "log"),
                    });
                    combined = mergeExtractStats(combined, stats);
                }
            }
            res.write(sseEvent("done", combined));
        }
        catch (e) {
            res.write(sseEvent("error", { detail: e instanceof Error ? e.message : String(e) }));
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
    app.post("/knowledge-bases/:kbId/import/commit", (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
            const append = Boolean(req.body.append);
            const store = ctx.cache.store(kid);
            const existing = store.getDocument().items;
            let startId = 1;
            if (existing.length) {
                const nums = existing.map((i) => parseInt(i.id.replace(/^q/, ""), 10)).filter((n) => !Number.isNaN(n));
                startId = nums.length ? Math.max(...nums) + 1 : 1;
            }
            const withIds = assignQuestionIds(rawItems, startId);
            if (append) {
                for (const item of withIds)
                    store.upsertItem(item);
            }
            else {
                store.replaceAll(1, [...existing.map((i) => ({ ...i })), ...withIds]);
            }
            ctx.cache.reloadKb(kid);
            ctx.opLog.append({ module: "generate", action: "commit", kb_id: kid, detail: `imported ${withIds.length} items` });
            res.json({ added: withIds.length, kb_id: kid, items: withIds });
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof Error ? e.message : String(e) });
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
