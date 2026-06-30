import { emptyTimings } from "../types.js";
import { LLMError } from "./llmClient.js";
import { buildMatchMessages, countQuestionPromptLines, parseConfidenceRaw, } from "./matcher.js";
export class AskLogSink {
    emit;
    opLog;
    module;
    kbId;
    entries = [];
    constructor(emit, opLog, module = "debug", kbId = "") {
        this.emit = emit;
        this.opLog = opLog;
        this.module = module;
        this.kbId = kbId;
    }
    log(line, kind = "log") {
        this.entries.push([line, kind]);
        this.emit?.(line, kind);
        this.opLog?.append({
            module: this.module,
            action: kind,
            kb_id: this.kbId,
            detail: line,
            kind,
        });
    }
}
function formatTimingsLog(timings) {
    const tok = timings.tokens;
    return (`[timing] 准备(索引+prompt)=${timings.prepare_ms.toFixed(1)}ms ` +
        `匹配(LLM)=${timings.match_ms.toFixed(1)}ms ` +
        `首token=${timings.match_first_token_ms.toFixed(1)}ms ` +
        `查表(取answer)=${timings.lookup_ms.toFixed(2)}ms ` +
        `总计=${timings.total_ms.toFixed(1)}ms ` +
        `tokens=${tok.total_tokens || timings.match_output_tokens}`);
}
function applyUsageToTimings(timings, usage) {
    timings.tokens = {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens || usage.prompt_tokens + usage.completion_tokens,
    };
    timings.match_output_tokens = usage.completion_tokens || timings.match_output_tokens;
    timings.token_breakdown = [{ phase: "match", usage: timings.tokens }];
}
export async function runConfidenceMatch(opts) {
    const log = (line, kind = "log") => opts.logSink?.log(line, kind);
    const timings = emptyTimings();
    const t0 = performance.now();
    log(`[step] runConfidenceMatch 开始 kb_id=${opts.kbId} top_k=${opts.topK}`, "step");
    let idx = opts.cache.getIndex(opts.kbId);
    if (!idx) {
        log("[cache] 内存索引未命中，执行 loadKb()", "cache");
        idx = opts.cache.loadKb(opts.kbId);
    }
    else {
        log(`[cache] 命中内存索引 loaded_at=${idx.loadedAt}`, "cache");
    }
    log(`[cache] enabled_items=${idx.enabledItems.length} prompt_lines=${countQuestionPromptLines(idx.enabledItems)}`, "cache");
    const systemPrompt = opts.cache.getConfidenceSystemPrompt(opts.kbId, opts.topK);
    const messagesDict = buildMatchMessages(systemPrompt, opts.question);
    const messages = messagesDict.map((m) => ({ role: m.role, content: m.content }));
    log(`[prompt] confidence system 长度=${systemPrompt.length} 字符`, "prompt");
    log(`[prompt] user 消息:\n${opts.question}`, "prompt");
    const modelName = opts.matchModel ?? opts.settings.matchModel;
    const tok = opts.maxTokens ?? opts.settings.confidenceMaxTokens;
    const temp = opts.temperature ?? opts.settings.matchTemperature;
    log(`[match] 调用 LLM model=${modelName} max_tokens=${tok} temperature=${temp}`, "match");
    const tMatch0 = performance.now();
    timings.prepare_ms = tMatch0 - t0;
    let firstTokenMs = 0;
    let buffer = "";
    let gotFirst = false;
    let deltaCount = 0;
    const usageHolder = [];
    for await (const delta of opts.llm.chatStream({
        model: modelName,
        messages,
        max_tokens: tok,
        temperature: temp,
        mock_mode: "confidence",
        usage_out: usageHolder,
    })) {
        if (opts.abortSignal?.aborted)
            throw new LLMError(`请求超时（${opts.settings.debugRequestTimeoutS}s）`);
        deltaCount++;
        if (!gotFirst) {
            firstTokenMs = performance.now() - tMatch0;
            gotFirst = true;
            log(`[match] 首 token 到达 +${firstTokenMs.toFixed(1)}ms`, "match");
        }
        buffer += delta;
    }
    const raw = buffer.trim();
    timings.match_ms = performance.now() - tMatch0;
    timings.match_first_token_ms = firstTokenMs;
    if (usageHolder.length)
        applyUsageToTimings(timings, usageHolder[0]);
    else
        timings.match_output_tokens = raw ? Math.max(1, raw.split(/\s+/).length) : 0;
    log(`[match] stream 结束 deltas=${deltaCount} raw_output=${JSON.stringify(raw)}`, "match");
    const { candidates: parsed, rawOutput } = parseConfidenceRaw(raw, idx.validIds, opts.topK);
    const candidates = [];
    const answers = [];
    for (const row of parsed) {
        const item = opts.cache.resolveItem(opts.kbId, row.id);
        const qText = item?.question ?? "";
        const ansText = item?.answer ?? "";
        candidates.push({ id: row.id, confidence: row.confidence, question: qText });
        answers.push({ id: row.id, confidence: row.confidence, question: qText, answer: ansText });
        log(`[parse] candidate id=${row.id} confidence=${row.confidence.toFixed(3)}`, "parse");
    }
    if (!candidates.length)
        log("[parse] 未解析到有效候选", "parse");
    const match = { raw_output: rawOutput, candidates };
    const tLookup0 = performance.now();
    const answer = answers[0]?.answer ?? "";
    if (answers[0])
        log(`[lookup] 取 Top1 answer len=${answer.length} id=${answers[0].id}`, "lookup");
    timings.lookup_ms = performance.now() - tLookup0;
    timings.total_ms = performance.now() - t0;
    log(`[step] runConfidenceMatch 完成 total=${timings.total_ms.toFixed(1)}ms`, "step");
    log(formatTimingsLog(timings), "timing");
    const resp = {
        question: opts.question,
        kb_id: opts.kbId,
        match,
        answer,
        answers,
        timings,
        cache_hit: true,
    };
    return [match, timings, systemPrompt, messagesDict, resp];
}
export function sseEvent(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
