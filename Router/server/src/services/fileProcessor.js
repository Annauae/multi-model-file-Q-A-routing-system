import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LLMError } from "./llmClient.js";
import { convertDocxToMarkdown, convertExcelToMarkdown, convertHtmlToMarkdown, collectImageRefsFromMarkdown, } from "./documentConverters.js";
import { formatFromFilename } from "./documentTypes.js";
import { refineMarkdownWithVlm } from "./documentVlmRefine.js";
import { documentsAssetsDirPath, documentsModulesDirPath, DOCLING_SCRIPT, MODEL_ROUTER_ROOT, } from "./paths.js";
import { copyDirAssetsToDocuments, rewriteAssetPathsInText } from "./assetSync.js";
const PLACEHOLDER_HEADING_RE = /^#{1,3}\s*前言\s*$/gm;
const DOCLING_META_BLOCK = /---\s*\n(?:(?!---).)*?(?:route:|route_label:|source_pdf:)(?:(?!---).)*?\n---\s*\n?/gis;
const MAX_VLM_REFINE_CHARS = 24_000;
export function stripMdFrontmatter(text) {
    let body = text || "";
    if (body.startsWith("---")) {
        const end = body.indexOf("\n---", 3);
        if (end !== -1)
            body = body.slice(end + 4);
    }
    return body.trim();
}
export function cleanPageMarkdown(mdText) {
    let text = mdText || "";
    for (let i = 0; i < 8; i++) {
        const prev = text;
        text = stripMdFrontmatter(text);
        text = text.replace(DOCLING_META_BLOCK, "");
        if (text === prev)
            break;
    }
    text = text.replace(PLACEHOLDER_HEADING_RE, "");
    const lines = text.split(/\r?\n/);
    while (lines.length && !lines[0].trim())
        lines.shift();
    while (lines.length && !lines[lines.length - 1].trim())
        lines.pop();
    return lines.join("\n").trim();
}
export function extractMdLineRange(mdText, lineStart, lineEnd) {
    const lines = mdText.split(/\r?\n/);
    if (lineStart < 1 || lineEnd < lineStart || lineStart > lines.length)
        return "";
    return lines.slice(lineStart - 1, Math.min(lines.length, lineEnd)).join("\n").trim();
}
function readExtractMetrics(outDir) {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const metricsPath = path.join(outDir, "extract_metrics.json");
    if (!fs.existsSync(metricsPath))
        return usage;
    try {
        const raw = JSON.parse(fs.readFileSync(metricsPath, "utf-8"));
        const tok = raw?.tokens;
        if (tok && typeof tok === "object") {
            usage.prompt_tokens = Number(tok.prompt_tokens ?? 0);
            usage.completion_tokens = Number(tok.completion_tokens ?? 0);
            usage.total_tokens = Number(tok.total_tokens ?? 0) || usage.prompt_tokens + usage.completion_tokens;
        }
    }
    catch {
        /* ignore */
    }
    return usage;
}
async function runPdfExtract(opts) {
    fs.mkdirSync(opts.outDir, { recursive: true });
    if (!fs.existsSync(DOCLING_SCRIPT)) {
        throw new LLMError(`PDF 提取脚本不存在: ${DOCLING_SCRIPT}，请确认 model_router 在同一 monorepo 内。`);
    }
    const cmd = [
        process.platform === "win32" ? "python" : "python3",
        DOCLING_SCRIPT,
        "--pdf",
        path.resolve(opts.pdfPath),
        "--page-start",
        String(opts.pageStart),
        "--page-end",
        String(opts.pageEnd),
        "--output-dir",
        path.resolve(opts.outDir),
    ];
    if (opts.vlmModel)
        cmd.push("--model", opts.vlmModel);
    let promptFile = null;
    if (opts.vlmSystemPrompt?.trim()) {
        promptFile = path.join(os.tmpdir(), `kr_vlm_prompt_${Date.now()}.txt`);
        fs.writeFileSync(promptFile, opts.vlmSystemPrompt.trim(), "utf-8");
        cmd.push("--vlm-system-prompt-file", promptFile);
    }
    const outputLines = [];
    await new Promise((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), {
            cwd: MODEL_ROUTER_ROOT,
            stdio: ["ignore", "pipe", "pipe"],
        });
        proc.stdout?.on("data", (buf) => {
            outputLines.push(buf.toString("utf-8"));
        });
        proc.stderr?.on("data", (buf) => {
            outputLines.push(buf.toString("utf-8"));
        });
        proc.on("close", (code) => {
            if (promptFile && fs.existsSync(promptFile))
                fs.unlinkSync(promptFile);
            if (code !== 0) {
                const tail = outputLines.join("").slice(-2000);
                reject(new LLMError(`PDF 提取失败 (${code}): ${tail}`));
            }
            else
                resolve();
        });
        proc.on("error", reject);
    });
    const stem = `knowledge_p${opts.pageStart}-${opts.pageEnd}`;
    let mdPath = path.join(opts.outDir, `${stem}.md`);
    if (!fs.existsSync(mdPath)) {
        const mdFiles = fs.readdirSync(opts.outDir).filter((f) => f.endsWith(".md"));
        if (!mdFiles.length)
            throw new LLMError("PDF 提取未生成 Markdown 文件");
        mdPath = path.join(opts.outDir, mdFiles[0]);
    }
    return [mdPath, readExtractMetrics(opts.outDir)];
}
export async function extractMarkdownRange(opts) {
    const { filesRoot, sourcePath, lineStart, lineEnd, onProgress, outputModulesDir } = opts;
    if (lineStart < 1 || lineEnd < lineStart)
        throw new LLMError("无效行范围");
    const t0 = performance.now();
    const mdText = fs.readFileSync(sourcePath, "utf-8");
    const chunk = extractMdLineRange(mdText, lineStart, lineEnd);
    if (!chunk)
        throw new LLMError(`行范围 ${lineStart}-${lineEnd} 无内容`);
    const modulesDir = outputModulesDir || documentsModulesDirPath(filesRoot);
    fs.mkdirSync(modulesDir, { recursive: true });
    const mergedMd = cleanPageMarkdown(chunk);
    const moduleOut = path.join(modulesDir, `module_l${lineStart}-${lineEnd}.md`);
    fs.writeFileSync(moduleOut, mergedMd, "utf-8");
    onProgress?.(`已读取 Markdown 第 ${lineStart}-${lineEnd} 行`);
    const totalMs = performance.now() - t0;
    const relRoot = outputModulesDir ? path.resolve(outputModulesDir) : path.resolve(filesRoot);
    const rel = outputModulesDir
        ? path.basename(moduleOut)
        : path.relative(relRoot, moduleOut).replace(/\\/g, "/");
    const stats = {
        pages: 0,
        line_count: mergedMd.split(/\r?\n/).length,
        module_path: rel,
        timings: { total_ms: totalMs, prepare_ms: totalMs, match_ms: 0, match_first_token_ms: 0, lookup_ms: 0 },
        tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        token_breakdown: [],
    };
    return [mergedMd, moduleOut, stats];
}
export async function extractPdfToMarkdown(opts) {
    const { filesRoot, sourcePath, pageStart, pageEnd, vlmModel, vlmSystemPrompt, onProgress, outputModulesDir } = opts;
    if (pageStart < 1 || pageEnd < pageStart)
        throw new LLMError("无效页码范围");
    const t0 = performance.now();
    const modulesDir = outputModulesDir || documentsModulesDirPath(filesRoot);
    const assetsDir = outputModulesDir
        ? path.join(outputModulesDir, "_assets")
        : documentsAssetsDirPath(filesRoot);
    const pagesDir = path.join(modulesDir, "pages");
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    const pageMds = [];
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const tokenBreakdown = [];
    let extractMs = 0;
    for (let i = pageStart; i <= pageEnd; i++) {
        onProgress?.(`正在提取第 ${i} 页（${i - pageStart + 1}/${pageEnd - pageStart + 1}）…`);
        const tPage = performance.now();
        const tmp = path.join(pagesDir, `_extract_p${i}`);
        const [mdPath, pageUsage] = await runPdfExtract({
            pdfPath: sourcePath,
            pageStart: i,
            pageEnd: i,
            outDir: tmp,
            vlmModel,
            vlmSystemPrompt,
        });
        onProgress?.(`第 ${i} 页提取完成`);
        totalUsage.prompt_tokens += pageUsage.prompt_tokens;
        totalUsage.completion_tokens += pageUsage.completion_tokens;
        totalUsage.total_tokens += pageUsage.total_tokens;
        if (pageUsage.total_tokens || pageUsage.prompt_tokens) {
            tokenBreakdown.push({ phase: `VLM · 第 ${i} 页`, usage: pageUsage });
        }
        extractMs += performance.now() - tPage;
        const mdText = rewriteAssetPathsInText(cleanPageMarkdown(fs.readFileSync(mdPath, "utf-8")));
        copyDirAssetsToDocuments(filesRoot, path.join(tmp, "assets"));
        const pageOut = path.join(pagesDir, `page_${i}.md`);
        fs.writeFileSync(pageOut, mdText, "utf-8");
        pageMds.push([i, mdText]);
        if (fs.existsSync(tmp))
            fs.rmSync(tmp, { recursive: true, force: true });
    }
    const mergedMd = cleanPageMarkdown(pageMds.map(([n, md]) => `<!-- page ${n} -->\n${md}`).join("\n\n"));
    const mergedPath = path.join(modulesDir, `merged_p${pageStart}-${pageEnd}.md`);
    fs.writeFileSync(mergedPath, mergedMd, "utf-8");
    onProgress?.(`已合并 ${pageMds.length} 页内容`);
    for (const [pageNo] of pageMds) {
        const pageFile = path.join(pagesDir, `page_${pageNo}.md`);
        if (fs.existsSync(pageFile))
            fs.unlinkSync(pageFile);
    }
    const totalMs = performance.now() - t0;
    const rel = outputModulesDir
        ? path.basename(mergedPath)
        : path.relative(path.resolve(filesRoot), mergedPath).replace(/\\/g, "/");
    const stats = {
        pages: pageMds.length,
        line_count: mergedMd.split(/\r?\n/).length,
        module_path: rel,
        timings: {
            total_ms: totalMs,
            prepare_ms: extractMs,
            match_ms: 0,
            match_first_token_ms: 0,
            lookup_ms: 0,
        },
        tokens: totalUsage,
        token_breakdown: tokenBreakdown,
    };
    return [mergedMd, mergedPath, stats];
}
export function mergeExtractStats(acc, stats) {
    if (!Object.keys(acc).length) {
        const mp = String(stats.module_path ?? "");
        return { ...stats, module_paths: mp ? [mp] : [] };
    }
    const accTimings = { ...(acc.timings ?? {}) };
    const stTimings = stats.timings ?? {};
    for (const k of new Set([...Object.keys(accTimings), ...Object.keys(stTimings)])) {
        accTimings[k] = (accTimings[k] ?? 0) + (stTimings[k] ?? 0);
    }
    const accTokens = { ...(acc.tokens ?? {}) };
    const stTokens = stats.tokens ?? {};
    for (const k of ["total_tokens", "prompt_tokens", "completion_tokens"]) {
        accTokens[k] = (accTokens[k] ?? 0) + (stTokens[k] ?? 0);
    }
    const modulePaths = [...(acc.module_paths ?? [])];
    const mp = String(stats.module_path ?? "");
    if (mp)
        modulePaths.push(mp);
    return {
        ...acc,
        timings: accTimings,
        tokens: accTokens,
        token_breakdown: [...(acc.token_breakdown ?? []), ...(stats.token_breakdown ?? [])],
        pages: Number(acc.pages ?? 0) + Number(stats.pages ?? 0),
        line_count: Number(acc.line_count ?? 0) + Number(stats.line_count ?? 0),
        module_paths: modulePaths,
        module_path: mp || acc.module_path,
    };
}

/** 将多段提取结果合并为单个 Markdown 模块文件 */
export function finalizeCombinedExtract(filesRoot, filename, ranges, isPdf, parts, combinedStats) {
    if (!parts.length)
        throw new LLMError("无提取内容");
    const shouldMerge = ranges.length > 1 && parts.length > 1;
    if (!shouldMerge) {
        const only = parts[0];
        return {
            ...combinedStats,
            markdown: only.md,
            path: only.modulePath,
            module_path: only.modulePath,
            module_paths: [only.modulePath],
        };
    }
    const modulesDir = documentsModulesDirPath(filesRoot);
    fs.mkdirSync(modulesDir, { recursive: true });
    const mergedMd = rewriteAssetPathsInText(cleanPageMarkdown(parts.map((p) => `<!-- ${p.label} -->\n${p.md}`).join("\n\n")));
    const rangeLabel = ranges.map(([s, e]) => (isPdf ? `p${s}-${e}` : `l${s}-${e}`)).join("_");
    const stem = path.basename(filename, path.extname(filename)).replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 80);
    const outName = isPdf ? `merged_${stem}_${rangeLabel}.md` : `module_${rangeLabel}.md`;
    const finalPath = path.resolve(path.join(modulesDir, outName));
    fs.writeFileSync(finalPath, mergedMd, "utf-8");
    for (const p of parts) {
        const abs = p.absPath ? path.resolve(p.absPath) : "";
        if (abs && abs !== finalPath && fs.existsSync(abs))
            fs.unlinkSync(abs);
    }
    const rel = path.relative(path.resolve(filesRoot), finalPath).replace(/\\/g, "/");
    return {
        ...combinedStats,
        markdown: mergedMd,
        path: rel,
        module_path: rel,
        module_paths: [rel],
        line_count: mergedMd.split(/\r?\n/).length,
    };
}

function buildExtractStats(t0, mergedMd, moduleOut, filesRoot, outputModulesDir, extra = {}) {
    const relRoot = outputModulesDir ? path.resolve(outputModulesDir) : path.resolve(filesRoot);
    const rel = outputModulesDir
        ? path.basename(moduleOut)
        : path.relative(relRoot, moduleOut).replace(/\\/g, "/");
    const totalMs = performance.now() - t0;
    return {
        line_count: mergedMd.split(/\r?\n/).length,
        module_path: rel,
        timings: {
            total_ms: totalMs,
            prepare_ms: extra.prepare_ms ?? totalMs,
            match_ms: extra.match_ms ?? 0,
            match_first_token_ms: 0,
            lookup_ms: 0,
            vlm_refine_ms: extra.vlm_refine_ms ?? 0,
        },
        tokens: extra.tokens ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        token_breakdown: extra.token_breakdown ?? [],
        warnings: extra.warnings ?? [],
        ...extra,
    };
}

export async function extractDocxToMarkdown(opts) {
    const { filesRoot, sourcePath, onProgress, outputModulesDir, settings, modelsStore, promptsStore, useVlmRefine = true, lineStart = null, lineEnd = null } = opts;
    const t0 = performance.now();
    onProgress?.("正在转换 Word 文档…");
    const { markdown: draft, warnings, imageRefs } = await convertDocxToMarkdown(filesRoot, sourcePath);
    let mergedMd = cleanPageMarkdown(draft);
    const allWarnings = [...warnings];
    if (lineStart != null && lineEnd != null) {
        const lines = draft.split(/\r?\n/);
        const start = Math.max(1, lineStart);
        const end = Math.min(Math.max(start, lineEnd), lines.length);
        mergedMd = cleanPageMarkdown(lines.slice(start - 1, end).join("\n"));
        if (!mergedMd.trim())
            allWarnings.push(`Word 第 ${start}-${end} 行无内容`);
    }
    const refsForVlm = imageRefs.filter((ref) => mergedMd.includes(ref));
    const vlmImageRefs = refsForVlm.length ? refsForVlm : collectImageRefsFromMarkdown(mergedMd);
    let statsExtra = { prepare_ms: performance.now() - t0 };

    if (useVlmRefine && mergedMd) {
        const refined = await refineMarkdownWithVlm({
            settings,
            modelsStore,
            promptsStore,
            filesRoot,
            draftMd: mergedMd,
            sourceFormat: "docx",
            imageRefs: vlmImageRefs,
            onProgress,
        });
        mergedMd = cleanPageMarkdown(refined.markdown);
        allWarnings.push(...refined.warnings);
        statsExtra = {
            prepare_ms: refined.timing_ms ? performance.now() - t0 - refined.timing_ms : statsExtra.prepare_ms,
            vlm_refine_ms: refined.timing_ms ?? 0,
            tokens: refined.usage,
            token_breakdown: refined.usage?.total_tokens
                ? [{ phase: "vlm_refine", usage: refined.usage }]
                : [],
            warnings: allWarnings,
        };
    }

    const modulesDir = outputModulesDir || documentsModulesDirPath(filesRoot);
    fs.mkdirSync(modulesDir, { recursive: true });
    const stem = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 80);
    const lineLabel = lineStart != null && lineEnd != null ? `_l${lineStart}-${lineEnd}` : "";
    const moduleOut = path.join(modulesDir, `merged_${stem}${lineLabel}.md`);
    fs.writeFileSync(moduleOut, mergedMd, "utf-8");
    onProgress?.("Word 转换完成");
    const stats = buildExtractStats(t0, mergedMd, moduleOut, filesRoot, outputModulesDir, statsExtra);
    return [mergedMd, moduleOut, stats];
}

export async function extractExcelToMarkdown(opts) {
    const { filesRoot, sourcePath, sheetName, onProgress, outputModulesDir, settings, modelsStore, promptsStore, useVlmRefine = true } = opts;
    const t0 = performance.now();
    onProgress?.("正在转换 Excel…");
    const { markdown: draft, sheet, warnings } = convertExcelToMarkdown(sourcePath, {
        sheetName,
        rowStart: 1,
        rowEnd: null,
    });
    let mergedMd = cleanPageMarkdown(draft);
    const allWarnings = [...warnings];
    let statsExtra = { prepare_ms: performance.now() - t0 };

    const skipVlm = !useVlmRefine || !mergedMd || mergedMd.length > MAX_VLM_REFINE_CHARS;
    if (useVlmRefine && mergedMd.length > MAX_VLM_REFINE_CHARS) {
        allWarnings.push(`表格过大（约 ${mergedMd.length} 字符），已跳过模型整理`);
    }

    if (useVlmRefine && mergedMd && !skipVlm) {
        const refined = await refineMarkdownWithVlm({
            settings,
            modelsStore,
            promptsStore,
            filesRoot,
            draftMd: mergedMd,
            sourceFormat: "xlsx",
            onProgress,
        });
        mergedMd = cleanPageMarkdown(refined.markdown);
        allWarnings.push(...refined.warnings);
        statsExtra = {
            prepare_ms: refined.timing_ms ? performance.now() - t0 - refined.timing_ms : statsExtra.prepare_ms,
            vlm_refine_ms: refined.timing_ms ?? 0,
            tokens: refined.usage,
            token_breakdown: refined.usage?.total_tokens
                ? [{ phase: "vlm_refine", usage: refined.usage }]
                : [],
            warnings: allWarnings,
        };
    }

    const modulesDir = outputModulesDir || documentsModulesDirPath(filesRoot);
    fs.mkdirSync(modulesDir, { recursive: true });
    const stem = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 60);
    const safeSheet = String(sheet).replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 30);
    const moduleOut = path.join(modulesDir, `merged_${stem}_${safeSheet}.md`);
    fs.writeFileSync(moduleOut, mergedMd, "utf-8");
    onProgress?.("Excel 转换完成");
    const stats = buildExtractStats(t0, mergedMd, moduleOut, filesRoot, outputModulesDir, statsExtra);
    return [mergedMd, moduleOut, stats];
}

export async function extractHtmlToMarkdown(opts) {
    const { filesRoot, sourcePath, lineStart, lineEnd, onProgress, outputModulesDir, settings, modelsStore, promptsStore, useVlmRefine = true, lineSliceOnly = false } = opts;
    const t0 = performance.now();
    const html = fs.readFileSync(sourcePath, "utf-8");

    if (lineSliceOnly || (lineStart != null && lineEnd != null && !useVlmRefine)) {
        return extractMarkdownRange({
            filesRoot,
            sourcePath,
            lineStart: lineStart ?? 1,
            lineEnd: lineEnd ?? html.split(/\r?\n/).length,
            onProgress,
            outputModulesDir,
        });
    }

    onProgress?.("正在转换 HTML…");
    const { markdown: draft, warnings } = convertHtmlToMarkdown(html, {
        lineStart: lineStart ?? undefined,
        lineEnd: lineEnd ?? undefined,
    });
    let mergedMd = cleanPageMarkdown(draft);
    const allWarnings = [...warnings];
    let statsExtra = { prepare_ms: performance.now() - t0 };

    if (useVlmRefine && mergedMd) {
        const refined = await refineMarkdownWithVlm({
            settings,
            modelsStore,
            promptsStore,
            filesRoot,
            draftMd: mergedMd,
            sourceFormat: "html",
            onProgress,
        });
        mergedMd = cleanPageMarkdown(refined.markdown);
        allWarnings.push(...refined.warnings);
        statsExtra = {
            prepare_ms: refined.timing_ms ? performance.now() - t0 - refined.timing_ms : statsExtra.prepare_ms,
            vlm_refine_ms: refined.timing_ms ?? 0,
            tokens: refined.usage,
            token_breakdown: refined.usage?.total_tokens
                ? [{ phase: "vlm_refine", usage: refined.usage }]
                : [],
            warnings: allWarnings,
        };
    }

    const modulesDir = outputModulesDir || documentsModulesDirPath(filesRoot);
    fs.mkdirSync(modulesDir, { recursive: true });
    const label = lineStart != null && lineEnd != null ? `l${lineStart}-${lineEnd}` : "full";
    const moduleOut = path.join(modulesDir, `module_${label}.md`);
    fs.writeFileSync(moduleOut, mergedMd, "utf-8");
    onProgress?.("HTML 转换完成");
    const stats = buildExtractStats(t0, mergedMd, moduleOut, filesRoot, outputModulesDir, statsExtra);
    return [mergedMd, moduleOut, stats];
}

export function detectSourceFormat(filename) {
    return formatFromFilename(filename) || path.extname(filename).slice(1).toLowerCase();
}

export async function extractSourceToMarkdown(opts) {
    const fmt = detectSourceFormat(opts.filename || opts.sourcePath);
    const common = {
        filesRoot: opts.filesRoot,
        sourcePath: opts.sourcePath,
        onProgress: opts.onProgress,
        outputModulesDir: opts.outputModulesDir,
        settings: opts.settings,
        modelsStore: opts.modelsStore,
        promptsStore: opts.promptsStore,
        useVlmRefine: opts.useVlmRefine !== false,
    };

    if (fmt === "pdf") {
        const [s, e] = opts.ranges?.[0] ?? [1, 5];
        return extractPdfToMarkdown({
            ...common,
            pageStart: s,
            pageEnd: e,
            vlmModel: opts.vlmModel,
            vlmSystemPrompt: opts.vlmSystemPrompt,
        });
    }
    if (fmt === "docx") {
        const [lineStart, lineEnd] = opts.ranges?.[0] ?? [1, 99999];
        return extractDocxToMarkdown({ ...common, lineStart, lineEnd });
    }
    if (fmt === "xlsx" || fmt === "xls" || fmt === "csv") {
        return extractExcelToMarkdown({
            ...common,
            sheetName: opts.sheetName,
        });
    }
    if (fmt === "html" || fmt === "htm") {
        const [lineStart, lineEnd] = opts.ranges?.[0] ?? [1, 99999];
        const html = fs.readFileSync(opts.sourcePath, "utf-8");
        const lineCount = html.split(/\r?\n/).length;
        if (opts.useVlmRefine === false) {
            return extractMarkdownRange({
                filesRoot: opts.filesRoot,
                sourcePath: opts.sourcePath,
                lineStart: Math.min(lineStart, lineCount),
                lineEnd: Math.min(lineEnd, lineCount),
                onProgress: opts.onProgress,
                outputModulesDir: opts.outputModulesDir,
            });
        }
        return extractHtmlToMarkdown({
            ...common,
            lineStart: Math.min(lineStart, lineCount),
            lineEnd: Math.min(lineEnd, lineCount),
        });
    }
    if (fmt === "md" || fmt === "txt" || fmt === "json") {
        const text = fs.readFileSync(opts.sourcePath, "utf-8");
        const lineCount = text.split(/\r?\n/).length;
        const [lineStart, lineEnd] = opts.ranges?.[0] ?? [1, lineCount];
        return extractMarkdownRange({
            filesRoot: opts.filesRoot,
            sourcePath: opts.sourcePath,
            lineStart: Math.max(1, lineStart),
            lineEnd: Math.min(lineEnd, lineCount),
            onProgress: opts.onProgress,
            outputModulesDir: opts.outputModulesDir,
        });
    }
    throw new LLMError(`不支持的文件类型: ${fmt}`);
}
