import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RagRetriever } from "./retriever.js";
import { ragEvalRunsDir } from "../paths.js";

function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function evalRunPath(filesRoot, kbId, runId) {
    const dir = ragEvalRunsDir(filesRoot, kbId);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${runId}.json`);
}

function sampleRows(mode, size, items, meta) {
    const rows = [];
    const holdoutMap = meta?.holdout_variants ?? {};
    if (mode === "question") {
        for (const item of items) {
            if (item.enabled)
                rows.push({ query: item.question, expected_item_id: item.id, sample_type: "question" });
        }
    }
    else if (mode === "indexed_variant" || mode === "holdout_variant") {
        for (const item of items) {
            if (!item.enabled)
                continue;
            const holdouts = new Set(holdoutMap[item.id] ?? []);
            for (const v of item.variants || []) {
                const isHoldout = holdouts.has(v);
                if (mode === "holdout_variant" && isHoldout)
                    rows.push({ query: v, expected_item_id: item.id, sample_type: mode });
                if (mode === "indexed_variant" && !isHoldout)
                    rows.push({ query: v, expected_item_id: item.id, sample_type: mode });
            }
        }
    }
    else {
        for (const item of items) {
            if (!item.enabled)
                continue;
            const holdouts = new Set(holdoutMap[item.id] ?? []);
            for (const v of item.variants || []) {
                if (holdouts.has(v))
                    rows.push({ query: v, expected_item_id: item.id, sample_type: "holdout_variant" });
            }
            rows.push({ query: item.question, expected_item_id: item.id, sample_type: "question" });
        }
    }
    for (let i = rows.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    return rows.slice(0, size);
}

function summarize(results) {
    const n = results.length || 1;
    const recallAt = (k) => {
        const hits = results.filter((r) => r.recall_at?.[k]);
        return hits.length / n;
    };
    return {
        count: results.length,
        recall_at_1: recallAt(1),
        recall_at_3: recallAt(3),
        recall_at_5: recallAt(5),
        avg_quality: results.reduce((s, r) => s + (r.quality_score || 0), 0) / n,
        avg_confidence: results.reduce((s, r) => s + (r.confidence || 0), 0) / n,
        failures: results.filter((r) => !r.recall_at?.[1]).slice(0, 10),
    };
}

export function startEvalRun(kbId, opts, ctx) {
    const runId = randomUUID().slice(0, 12);
    const run = {
        run_id: runId,
        kb_id: kbId,
        status: "queued",
        size: opts.size,
        mode: opts.mode,
        top_k: opts.top_k,
        created_at: nowIso(),
        updated_at: nowIso(),
        summary: {},
        results: [],
    };
    const filePath = evalRunPath(ctx.settings.filesRoot, kbId, runId);
    fs.writeFileSync(filePath, JSON.stringify(run, null, 2), "utf-8");

    setImmediate(() => {
        void runEvalAsync(kbId, runId, opts, ctx).catch((err) => {
            console.error(`[rag/eval] run ${runId} failed:`, err);
        });
    });
    return runId;
}

async function runEvalAsync(kbId, runId, opts, ctx) {
    const filePath = evalRunPath(ctx.settings.filesRoot, kbId, runId);
    const readRun = () => JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const writeRun = (data) => fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");

    let run = readRun();
    run.status = "running";
    run.updated_at = nowIso();
    writeRun(run);

    const store = ctx.getRagQuestionsStore(kbId);
    const doc = store.getDocument();
    const { readIndexMeta } = await import("./indexStatus.js");
    const meta = readIndexMeta(ctx.settings.filesRoot, kbId);
    const runtime = ctx.getRuntimeConfig(kbId);
    const retriever = new RagRetriever(kbId, ctx, runtime);
    const samples = sampleRows(opts.mode, opts.size, doc.items, meta);

    const results = [];
    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        try {
            const chat = await retriever.chat(sample.query, { topN: opts.top_k });
            const ids = (chat.sources || []).map((s) => s.id);
            const recall_at = {
                1: ids.slice(0, 1).includes(sample.expected_item_id),
                3: ids.slice(0, 3).includes(sample.expected_item_id),
                5: ids.slice(0, 5).includes(sample.expected_item_id),
            };
            const expected = doc.items.find((it) => it.id === sample.expected_item_id);
            const judge = expected
                ? await ctx.ragLlmClient.judge(sample.query, expected.answer, chat.answer, chat.sources || [])
                : { quality_score: 0, confidence: 0 };
            results.push({
                sample_index: i,
                query: sample.query,
                expected_item_id: sample.expected_item_id,
                actual_item_id: ids[0] || "",
                sample_type: sample.sample_type,
                recall_at,
                answer: chat.answer,
                quality_score: judge.quality_score,
                confidence: judge.confidence ?? chat.confidence,
                timing: chat.timing,
            });
        }
        catch (err) {
            results.push({
                sample_index: i,
                query: sample.query,
                expected_item_id: sample.expected_item_id,
                error: String(err),
                recall_at: { 1: false, 3: false, 5: false },
            });
        }
        run = readRun();
        run.results = results;
        run.summary = summarize(results);
        run.updated_at = nowIso();
        writeRun(run);
    }

    run = readRun();
    run.status = "completed";
    run.completed_at = nowIso();
    run.summary = summarize(results);
    run.updated_at = nowIso();
    writeRun(run);
}

export function getEvalRun(filesRoot, kbId, runId) {
    const filePath = evalRunPath(filesRoot, kbId, runId);
    if (!fs.existsSync(filePath))
        return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function listEvalRuns(filesRoot, kbId, limit = 10) {
    const dir = ragEvalRunsDir(filesRoot, kbId);
    if (!fs.existsSync(dir))
        return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
            try {
                const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
                return {
                    run_id: raw.run_id,
                    status: raw.status,
                    size: raw.size,
                    mode: raw.mode,
                    created_at: raw.created_at,
                    updated_at: raw.updated_at,
                    summary: raw.summary,
                };
            }
            catch {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
}
