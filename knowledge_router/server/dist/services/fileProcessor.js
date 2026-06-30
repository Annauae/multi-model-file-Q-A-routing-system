import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LLMError } from "./llmClient.js";
import { documentsAssetsDirPath, documentsModulesDirPath, DOCLING_SCRIPT, MODEL_ROUTER_ROOT, } from "./paths.js";
const PLACEHOLDER_HEADING_RE = /^#{1,3}\s*前言\s*$/gm;
const DOCLING_META_BLOCK = /---\s*\n(?:(?!---).)*?(?:route:|route_label:|source_pdf:)(?:(?!---).)*?\n---\s*\n?/gis;
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
            const line = buf.toString("utf-8");
            outputLines.push(line);
            opts.onProgress?.(line.replace(/\r?\n$/, ""));
        });
        proc.stderr?.on("data", (buf) => {
            const line = buf.toString("utf-8");
            outputLines.push(line);
            opts.onProgress?.(line.replace(/\r?\n$/, ""));
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
    const { filesRoot, sourcePath, lineStart, lineEnd, onProgress } = opts;
    if (lineStart < 1 || lineEnd < lineStart)
        throw new LLMError("无效行范围");
    const t0 = performance.now();
    const mdText = fs.readFileSync(sourcePath, "utf-8");
    const chunk = extractMdLineRange(mdText, lineStart, lineEnd);
    if (!chunk)
        throw new LLMError(`行范围 ${lineStart}-${lineEnd} 无内容`);
    const modulesDir = documentsModulesDirPath(filesRoot);
    fs.mkdirSync(modulesDir, { recursive: true });
    const mergedMd = cleanPageMarkdown(chunk);
    const moduleOut = path.join(modulesDir, `module_l${lineStart}-${lineEnd}.md`);
    fs.writeFileSync(moduleOut, mergedMd, "utf-8");
    onProgress?.(`[step] 已读取 Markdown 行 ${lineStart}-${lineEnd}`);
    const totalMs = performance.now() - t0;
    const rel = path.relative(path.resolve(filesRoot), moduleOut).replace(/\\/g, "/");
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
    const { filesRoot, sourcePath, pageStart, pageEnd, vlmModel, vlmSystemPrompt, onProgress } = opts;
    if (pageStart < 1 || pageEnd < pageStart)
        throw new LLMError("无效页码范围");
    const t0 = performance.now();
    const modulesDir = documentsModulesDirPath(filesRoot);
    const assetsDir = documentsAssetsDirPath(filesRoot);
    const pagesDir = path.join(modulesDir, "pages");
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    const pageMds = [];
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const tokenBreakdown = [];
    let extractMs = 0;
    for (let i = pageStart; i <= pageEnd; i++) {
        onProgress?.(`[step] 提取第 ${i} 页 (${i - pageStart + 1}/${pageEnd - pageStart + 1})…`);
        const tPage = performance.now();
        const tmp = path.join(pagesDir, `_extract_p${i}`);
        const [mdPath, pageUsage] = await runPdfExtract({
            pdfPath: sourcePath,
            pageStart: i,
            pageEnd: i,
            outDir: tmp,
            vlmModel,
            vlmSystemPrompt,
            onProgress,
        });
        totalUsage.prompt_tokens += pageUsage.prompt_tokens;
        totalUsage.completion_tokens += pageUsage.completion_tokens;
        totalUsage.total_tokens += pageUsage.total_tokens;
        if (pageUsage.total_tokens || pageUsage.prompt_tokens) {
            tokenBreakdown.push({ phase: `VLM · 第 ${i} 页`, usage: pageUsage });
        }
        extractMs += performance.now() - tPage;
        const mdText = cleanPageMarkdown(fs.readFileSync(mdPath, "utf-8"));
        const pageOut = path.join(pagesDir, `page_${i}.md`);
        fs.writeFileSync(pageOut, mdText, "utf-8");
        pageMds.push([i, mdText]);
        if (fs.existsSync(tmp))
            fs.rmSync(tmp, { recursive: true, force: true });
    }
    const mergedMd = cleanPageMarkdown(pageMds.map(([n, md]) => `<!-- page ${n} -->\n${md}`).join("\n\n"));
    const mergedPath = path.join(modulesDir, `merged_p${pageStart}-${pageEnd}.md`);
    fs.writeFileSync(mergedPath, mergedMd, "utf-8");
    onProgress?.(`[step] 已合并 ${pageMds.length} 页 Markdown`);
    for (const [pageNo] of pageMds) {
        const pageFile = path.join(pagesDir, `page_${pageNo}.md`);
        if (fs.existsSync(pageFile))
            fs.unlinkSync(pageFile);
    }
    const totalMs = performance.now() - t0;
    const rel = path.relative(path.resolve(filesRoot), mergedPath).replace(/\\/g, "/");
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
