import fs from "node:fs";
import path from "node:path";
import { LLMClient, LLMError } from "./llmClient.js";
import { collectImageRefsFromMarkdown } from "./documentConverters.js";
import { documentsAssetsDirPath } from "./paths.js";
import { DEFAULT_DOC_REFINE_PROMPT_ZH } from "./promptDefaults.js";

const MAX_IMAGES = 8;

function mimeFromExt(ext) {
    const e = ext.toLowerCase();
    if (e === ".png")
        return "image/png";
    if (e === ".jpg" || e === ".jpeg")
        return "image/jpeg";
    if (e === ".gif")
        return "image/gif";
    if (e === ".webp")
        return "image/webp";
    return "image/png";
}

function resolveAssetPath(filesRoot, ref) {
    let r = String(ref || "").trim().replace(/\\/g, "/");
    if (r.startsWith("../"))
        r = r.slice(3);
    if (r.startsWith("assets/"))
        r = r.slice(7);
    const base = path.resolve(documentsAssetsDirPath(filesRoot));
    const full = path.resolve(path.join(base, r));
    if (!full.startsWith(base))
        return null;
    return full;
}

function loadImageDataUrls(filesRoot, imageRefs) {
    const urls = [];
    for (const ref of imageRefs.slice(0, MAX_IMAGES)) {
        const full = resolveAssetPath(filesRoot, ref);
        if (!full || !fs.existsSync(full))
            continue;
        const buf = fs.readFileSync(full);
        const mime = mimeFromExt(path.extname(full));
        urls.push(`data:${mime};base64,${buf.toString("base64")}`);
    }
    return urls;
}

function stripCodeFence(text) {
    let t = String(text || "").trim();
    if (t.startsWith("```")) {
        t = t.replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "");
    }
    return t.trim();
}

const MAX_VLM_REFINE_CHARS = 24_000;

function chatWithTimeout(llm, opts, timeoutMs) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LLMError(`模型整理超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
    });
    return Promise.race([llm.chat(opts), timeoutPromise]).finally(() => clearTimeout(timer));
}

export async function refineMarkdownWithVlm(opts) {
    const {
        settings,
        modelsStore,
        promptsStore,
        filesRoot,
        draftMd,
        sourceFormat = "docx",
        imageRefs = null,
        onProgress,
    } = opts;

    const warnings = [];
    if (settings.mockLlm) {
        warnings.push("MOCK_LLM 已开启，跳过模型整理");
        return { markdown: draftMd, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, warnings };
    }

    const cfg = modelsStore.getSlot("pdf_vlm");
    const llm = new LLMClient(settings).withCredentials({
        api_base_url: cfg.api_base_url,
        api_key: cfg.api_key,
        enable_thinking: cfg.enable_thinking ?? null,
    });

    const pdfPrompt = promptsStore.effectivePdfVlmPrompt();
    const refinePrompt = pdfPrompt.trim() || DEFAULT_DOC_REFINE_PROMPT_ZH;
    const refs = imageRefs ?? collectImageRefsFromMarkdown(draftMd);
    const imageUrls = loadImageDataUrls(filesRoot, refs);
    const useMultimodal = imageUrls.length > 0 && !llm.useOllamaNative();

    const userIntro = `以下是从 ${sourceFormat.toUpperCase()} 自动转换的 Markdown 初稿，请整理为规范 Markdown：\n\n${draftMd}`;
    let userContent;
    if (useMultimodal) {
        userContent = [{ type: "text", text: userIntro }];
        for (const url of imageUrls) {
            userContent.push({ type: "image_url", image_url: { url } });
        }
    }
    else {
        userContent = userIntro;
        if (refs.length && !imageUrls.length)
            warnings.push("配图文件未找到，模型仅做文本整理");
    }

    onProgress?.("模型整理中…");
    const t0 = performance.now();
    const timeoutMs = Math.max(30, Number(settings.vlmRefineTimeoutS ?? settings.debugRequestTimeoutS ?? 120)) * 1000;
    try {
        const [text, usage] = await chatWithTimeout(llm, {
            model: cfg.model,
            messages: [
                { role: "system", content: refinePrompt },
                { role: "user", content: userContent },
            ],
            max_tokens: cfg.max_tokens ?? settings.maxTokens,
            temperature: cfg.temperature ?? 0,
        }, timeoutMs);
        const markdown = stripCodeFence(text);
        if (!markdown) {
            warnings.push("模型整理返回空内容，已使用初稿");
            return {
                markdown: draftMd,
                usage,
                warnings,
                timing_ms: performance.now() - t0,
            };
        }
        onProgress?.(`模型整理完成（tokens=${usage.total_tokens || 0}）`);
        return { markdown, usage, warnings, timing_ms: performance.now() - t0 };
    }
    catch (e) {
        warnings.push(`模型整理失败，已使用初稿：${e instanceof LLMError ? e.message : String(e)}`);
        return {
            markdown: draftMd,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            warnings,
            timing_ms: performance.now() - t0,
        };
    }
}
