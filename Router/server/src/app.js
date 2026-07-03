/**
 * Router 服务端 Express 应用工厂
 *
 * 本模块负责：
 * 1. 初始化应用上下文（数据库 Store、FAQ 缓存、RAG 上下文等）
 * 2. 注册全部 HTTP API 路由（知识库、问答匹配、文档处理、设置等）
 * 3. 挂载前端静态资源与 SPA 回退
 *
 * 导出：
 * - createAppContext() — 异步创建共享上下文，供 createApp 与测试复用
 * - createApp(ctx, clientDist?) — 基于上下文构建 Express 实例
 */

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multer from "multer";

// 配置与持久化层
import { APP_ROOT, loadSettings } from "./config.js";
import { KbStore } from "./db/stores/kbStore.js";
import { ModelsStore } from "./db/stores/modelsStore.js";
import { MatchProfilesStore } from "./db/stores/matchProfilesStore.js";
import { PromptsStore } from "./db/stores/promptsStore.js";
import { OperationLog } from "./db/stores/operationLog.js";

// 业务服务
import { QuestionsCache } from "./services/questionsCache.js";
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

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 修正 multer 上传文件名编码。
 * multer 默认按 latin1 解析 originalname，中文文件名会变成乱码；
 * 若解码后出现 CJK 而原串没有，则采用 UTF-8 解码结果。
 */
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

/** 校验 kb_id 非空且在 KbStore 中存在，失败时抛出带 status 的 Error */
function validateKbId(ctx, kbId) {
    const kid = (kbId || "").trim();
    if (!kid)
        throw httpError(400, "kb_id 不能为空");
    if (!ctx.kbStore.get(kid))
        throw httpError(404, "kb_id 不存在");
    return kid;
}

/** 构造可被全局错误中间件识别的 HTTP 异常（含 status、detail） */
function httpError(status, detail) {
    const e = new Error(detail);
    e.status = status;
    e.detail = detail;
    return e;
}

/** 按「匹配配置档」(match profile) 创建 LLM 客户端，用于置信度问答 */
function llmForProfile(settings, profile) {
    return new LLMClient(settings).withCredentials({
        api_base_url: profile.api_base_url,
        api_key: profile.api_key,
        enable_thinking: profile.enable_thinking ?? null,
    });
}

/** 按模型槽位名（如 import、pdf_vlm）创建 LLM 客户端 */
function llmForSlot(settings, modelsStore, slot) {
    const cfg = modelsStore.getSlot(slot);
    return new LLMClient(settings).withCredentials({
        api_base_url: cfg.api_base_url,
        api_key: cfg.api_key,
        enable_thinking: cfg.enable_thinking ?? null,
    });
}

/**
 * 规范化文档提取页码/行号范围。
 * 输入形如 [[1,5],[10,12]]，过滤非法项，仅保留 start/end 均为正整数且 start <= end 的区间。
 */
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

/** 返回排序后的第一个知识库 ID，供提示词预览等默认选中用 */
function firstKbId(ctx) {
    const ids = Object.keys(ctx.kbStore.getAll()).sort((a, b) => {
        if (/^\d+$/.test(a) && /^\d+$/.test(b))
            return parseInt(a, 10) - parseInt(b, 10);
        return a.localeCompare(b);
    });
    return ids[0] ?? "";
}

// ---------------------------------------------------------------------------
// 应用上下文
// ---------------------------------------------------------------------------

/**
 * 创建并初始化服务端共享上下文。
 * 初始化顺序有依赖：PromptsStore 变更会触发 QuestionsCache 重载；
 * QuestionsCache 依赖 KbStore；MatchProfilesStore 依赖 ModelsStore。
 */
export async function createAppContext() {
    const settings = loadSettings();
    const kbStore = new KbStore();
    await kbStore.init();
    const modelsStore = ModelsStore.fromSettings(settings);
    await modelsStore.init();
    const opLog = new OperationLog();

    // cache 需在 promptsStore 之后创建：提示词变更时 reloadAll FAQ 索引
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

// ---------------------------------------------------------------------------
// Express 应用与路由
// ---------------------------------------------------------------------------

/**
 * 基于已初始化的 ctx 构建 Express 应用并注册全部路由。
 * @param {object} ctx - createAppContext() 的返回值
 * @param {string} [clientDist] - 前端构建产物目录，默认 APP_ROOT/client/dist
 */
export function createApp(ctx, clientDist) {
    const app = express();

    // 大 JSON 体（如批量 FAQ 导入）
    app.use(express.json({ limit: "50mb" }));

    // 内存上传，供 /documents/upload 使用
    const upload = multer({ storage: multer.memoryStorage() });

    // 将 validateKbId / httpError 等抛出的带 status 错误转为 JSON 响应
    app.use((err, _req, res, next) => {
        if (err.status)
            return res.status(err.status).json({ detail: err.detail ?? err.message });
        next(err);
    });

    /** 解析 match_profile_id，无效 ID 转为 400 */
    const resolveProfile = (profileId = "") => {
        try {
            return ctx.matchProfilesStore.get(profileId);
        }
        catch (e) {
            throw httpError(400, e instanceof Error ? e.message : String(e));
        }
    };

    // ----- 健康检查 & RAG 子路由（见 routes/ragRoutes.js） -----
    app.get("/health", (_req, res) => res.json({ status: "ok" }));
    registerRagRoutes(app, ctx, ctx.ragCtx);

    // ----- 置信度匹配：同步 JSON 接口 -----
    /** POST /ask/confidence — 一次性返回匹配结果与答案，无中间日志 */
    app.post("/ask/confidence", async (req, res) => {
        try {
            const question = String(req.body.question ?? "").trim();
            if (!question)
                throw httpError(400, "question 不能为空");
            const kbId = validateKbId(ctx, req.body.kb_id); // 校验 kb_id 非空且在 KbStore 中存在
            const profile = resolveProfile(req.body.match_profile_id); // 解析 API 地址、Key、model、max_tokens、temperature
            const [, , , , resp] = await runConfidenceMatch({
                question,
                kbId,
                topK: Math.max(1, Math.min(20, Number(req.body.top_k ?? 5))), // 限制 top_k 在 1-20 之间
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
    /**
     * LLM 置信度匹配 — 流式接口（调试页「提问」按钮调用此路由）
     *
     * 请求体：{ question, kb_id, top_k?, match_profile_id? }
     * SSE 事件顺序：log（步骤日志，可多条）→ candidates → done | error
     *
     * 与 POST /ask/confidence 逻辑相同，额外通过 SSE 推送中间日志与分阶段结果。
     */
    app.post("/ask/confidence/stream", async (req, res) => {
        const question = String(req.body.question ?? "").trim(); // 获取问题
        if (!question)
            return res.status(400).json({ detail: "question 不能为空" });
        let kbId;
        try {
            kbId = validateKbId(ctx, req.body.kb_id); // 校验 kb_id 非空且在 KbStore 中存在
        }
        catch (e) {
            return res.status(e.status).json({ detail: e.detail });
        }
        const topK = Math.max(1, Math.min(20, Number(req.body.top_k ?? 5))); // 限制 top_k 在 1-20 之间
        const profile = resolveProfile(req.body.match_profile_id); // 解析 API 地址、Key、model、max_tokens、temperature

        // 切换为 SSE 响应，禁止代理缓冲，防止中间日志丢失
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), ctx.settings.debugRequestTimeoutS * 1000);

        // logQueue + worker 模式：runConfidenceMatch 在后台跑，主循环把日志实时写给客户端
        const logQueue = [];
        const box = { matchResult: null, workerError: null, done: false };
        const worker = (async () => {
            const sink = new AskLogSink((line, kind) => logQueue.push(["log", line, kind]), ctx.opLog, "debug", kbId); // 创建日志 sink，将日志推送到 logQueue
            try {
                sink.log("[step] POST /ask/confidence/stream 收到请求", "step");
                // 核心：加载 FAQ 索引 → 拼 prompt → LLM 流式匹配 → 解析 JSON → 查 answer
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

        // 轮询推送 log 事件，直到 worker 结束且队列清空
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
        // candidates：前端左 Tab「候选匹配」用（此时尚无 answer 正文）
        res.write(sseEvent("candidates", {
            raw_output: match.raw_output,
            candidates: match.candidates,
            enabled_count: (await ctx.cache.getEnabledCount(kbId)),
            messages: messagesDict,
        }));
        // done：前端右侧「候选回答」+ timings；answers 每项含完整 answer Markdown
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

    // ----- LLM 知识库 CRUD 与缓存 -----
    /** GET /knowledge-bases — 列出所有 LLM 知识库及 enabled FAQ 条数 */
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
    /** POST /knowledge-bases — 创建知识库；kb_id 可省略则自动分配 */
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
    /** GET /knowledge-bases/:kbId — 单个知识库详情 */
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
    /** DELETE /knowledge-bases/:kbId — 删除知识库、清缓存与磁盘目录 */
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
    /** POST /knowledge-bases/:kbId/rename — 修改显示名称 */
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
    /** GET /knowledge-bases/:kbId/confidence-prompt-preview — 预览置信度匹配 system prompt */
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
    /** POST /knowledge-bases/:kbId/reload — 从磁盘重新加载 FAQ 索引到内存缓存 */
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
    /** POST /knowledge-bases/:kbId/import/from-rag — 从 RAG 知识库导入 FAQ 到 LLM 库 */
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

    // ----- FAQ 条目 CRUD（持久化在 questions JSON，变更后 reloadKb） -----
    /** GET /knowledge-bases/:kbId/questions — 完整 FAQ 文档 { version, items } */
    app.get("/knowledge-bases/:kbId/questions", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(await ctx.cache.store(kid).getDocument());
        }
        catch (e) {
            res.status(404).json({ detail: e.detail ?? String(e) });
        }
    });
    /** PUT /knowledge-bases/:kbId/questions — 全量替换 FAQ 列表（带乐观锁 version） */
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
    /** POST /knowledge-bases/:kbId/questions/items — 新增单条 FAQ */
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
    /** PUT /knowledge-bases/:kbId/questions/items/:itemId — 更新单条 FAQ */
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
    /** DELETE /knowledge-bases/:kbId/questions/items/:itemId — 删除单条 FAQ */
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

    // ----- 静态资源预览（防路径穿越） -----
    /** GET /preview-asset?kb_id=&ref= — 知识库 assets 目录下的图片等资源 */
    app.get("/preview-asset", (req, res) => {
        try {
            const kid = validateKbId(ctx, String(req.query.kb_id ?? ""));
            // 规范化 ref，去掉 ../、assets/ 前缀，禁止 .. 穿越
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
    /** GET /documents/preview-asset?ref= — 文档模块全局 assets 目录 */
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

    // ----- 操作日志：轮询与 SSE 流 -----
    /** GET /logs — 按 module/kb_id/level 过滤的历史日志 */
    app.get("/logs", async (req, res) => {
        const items = await ctx.opLog.listEntries({
            limit: Number(req.query.limit ?? 500),
            modules: String(req.query.modules ?? req.query.module ?? ""),
            kb_id: String(req.query.kb_id ?? ""),
            level: String(req.query.level ?? ""),
        });
        res.json({ items });
    });
    /** GET /logs/stream — SSE 推送 since 之后的新日志，每秒轮询一次 */
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

    // ----- 系统设置：提示词、匹配配置档、模型槽位 -----
    /** GET /settings/prompts — 当前提示词及基于默认 kb 的 system 预览 */
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
    /** PUT /settings/prompts — 更新置信度/FAQ/PDF-VLM 提示词（部分字段可选） */
    app.put("/settings/prompts", async (req, res) => {
        const gp = await ctx.promptsStore.set({
            confidence_match_prompt: "confidence_match_prompt" in req.body ? req.body.confidence_match_prompt : undefined,
            faq_generation_prompt: "faq_generation_prompt" in req.body ? req.body.faq_generation_prompt : undefined,
            pdf_vlm_prompt: "pdf_vlm_prompt" in req.body ? req.body.pdf_vlm_prompt : undefined,
        });
        ctx.opLog.append({ module: "settings", action: "update_prompts", detail: "更新问答模型提示词" });
        res.json({ ...gp, defaults: allDefaultPrompts(ctx.settings.confidenceTopK) });
    });
    /** GET /settings/match-profiles — 问答匹配用的多档 API/模型配置 */
    app.get("/settings/match-profiles", (_req, res) => {
        res.json({
            default_id: ctx.matchProfilesStore.getDefaultId(),
            profiles: ctx.matchProfilesStore.listProfiles(false),
        });
    });
    /** PUT /settings/match-profiles — 批量更新匹配配置档 */
    app.put("/settings/match-profiles", async (req, res) => {
        const updated = await ctx.matchProfilesStore.updateAll(req.body);
        ctx.opLog.append({ module: "settings", action: "update_match_profiles", detail: "更新问答模型配置" });
        res.json(updated);
    });
    /** GET /settings/models — 各功能槽位模型（import、pdf_vlm 等） */
    app.get("/settings/models", (_req, res) => {
        res.json({ slots: ctx.modelsStore.getAll(false) });
    });
    /** PUT /settings/models — 更新模型槽位；body 可为 { slots: {...} } 或直接为 slots 对象 */
    app.put("/settings/models", async (req, res) => {
        const slots = req.body.slots && typeof req.body.slots === "object" ? req.body.slots : req.body;
        const updated = await ctx.modelsStore.updateAll(slots ?? {});
        ctx.opLog.append({ module: "settings", action: "update_models", detail: "更新模型配置" });
        res.json({ slots: updated });
    });

    // ----- 召回测试用例（调试页） -----
    /** GET /knowledge-bases/:kbId/recall-tests — 读取召回测试数据集 */
    app.get("/knowledge-bases/:kbId/recall-tests", async (req, res) => {
        try {
            const kid = validateKbId(ctx, req.params.kbId);
            res.json(await ctx.ragCtx.getLlmRecallTestsStore(kid).getDocument());
        }
        catch (e) {
            res.status(404).json({ detail: e.detail ?? String(e) });
        }
    });
    /** PUT /knowledge-bases/:kbId/recall-tests — 保存召回测试数据集 */
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

    // ----- 文档 / Markdown 文件管理 -----
    /** GET /markdown-files/tree — 文档目录树（modules 与 sources） */
    app.get("/markdown-files/tree", (_req, res) => {
        res.json(buildMarkdownFilesTree(ctx.settings.filesRoot));
    });
    /** GET /documents/capabilities — 支持的源文件类型及提取能力说明 */
    app.get("/documents/capabilities", (_req, res) => {
        res.json(listCapabilitiesPayload());
    });
    /** GET /documents/preview-file?path= — 内联预览 PDF 源文件 */
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
    /** GET /documents/excel-sheets?filename= — 列出 Excel 工作表名供前端选择 */
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
    /** GET /markdown-files/content?path= — 读取模块 Markdown 内容及元数据 */
    app.get("/markdown-files/content", async (req, res) => {
        try {
            res.json(await readDocumentContent(ctx.settings.filesRoot, String(req.query.path ?? "")));
        }
        catch (e) {
            res.status(400).json({ detail: e instanceof LLMError ? e.message : String(e) });
        }
    });
    /** PUT /markdown-files/content — 保存模块 Markdown */
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
    /** DELETE /markdown-files?path= — 删除文档文件 */
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
    /** PUT /markdown-files/rename — 重命名文档文件 */
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
    /** POST /markdown-files — 新建模块 Markdown 文件 */
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
    /**
     * POST /documents/upload — 上传源文件到 documents/sources
     * multipart 字段 file；overwrite 可通过 query/body 覆盖已存在文件
     */
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

    /**
     * POST /documents/extract/stream — 流式提取源文件为 Markdown（SSE）
     *
     * 请求体：filename, ranges（页码或行号区间）, sheet_name?, use_vlm_refine?
     * 支持 PDF / Word / Excel / 纯文本等；多段 range 会合并为一个 module 文件。
     * SSE 事件：log（步骤）→ done（path、stats）| error
     */
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

        // SSE 响应头 + 首包 comment，避免代理缓冲
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
        // 长任务期间定期发送 keepalive，防止连接被中间层断开
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
            // 多段 PDF/行范围：各段先写入临时目录，最后 merge 为一个 module
            const multiRange = ranges.length > 1 && (isPdf || isLineRange);
            if (multiRange) {
                stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kr-extract-"));
                emitStep(`共 ${ranges.length} 段范围，将合并为单个 Markdown…`);
            }
            let combined = {};
            const extractParts = [];
            const allWarnings = [];
            const rangeList = isExcel ? [[1, 1]] : ranges; // Excel 用 sheet_name，range 占位
            for (const [rangeStart, rangeEnd] of rangeList) {
                const rangeOutDir = multiRange
                    ? path.join(stagingRoot, `${isPdf ? "p" : "l"}${rangeStart}-${rangeEnd}`)
                    : undefined;
                if (rangeOutDir)
                    fs.mkdirSync(rangeOutDir, { recursive: true });
                let mergedMd;
                let moduleOut;
                let stats;
                // 按文件类型选择提取管线
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
                    // 纯文本/Markdown：直接按行切片；HTML 可选 VLM 精修
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
            // 写入 modules 目录并返回相对 path、统计信息
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
            // 清理多段提取时的临时目录
            if (stagingRoot && fs.existsSync(stagingRoot))
                fs.rmSync(stagingRoot, { recursive: true, force: true });
        }
        res.end();
    });

    // ----- FAQ 导入流水线：LLM 生成问法 → 提交到 LLM/RAG 库 -----
    /** POST .../import/generate-questions — 根据 answer_md 用 import 槽位模型生成标准问与变体 */
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
    /**
     * POST .../import/commit — 将生成的 FAQ 写入 LLM 和/或 RAG 知识库
     * targets: ["llm"] | ["rag"] | 两者；append 为 true 时追加，否则与现有合并替换
     * RAG 写入后默认 auto_rebuild_rag 重建向量索引
     */
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

            /** 为 rawItems 分配 qN  id，并按 append 模式写入 store */
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

    // ----- 静态资源与 SPA 回退 -----
    // 旧版静态页、client/public、生产 dist；无 dist 时回退 legacy index.html
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
        // 非 API、非带扩展名静态文件的 GET 均返回 index.html（React Router）
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
