import { randomUUID } from "node:crypto";
import { RagRetriever } from "./retriever.js";
import * as ragMetaRepo from "../../db/repositories/ragMetaRepo.js";
import { readIndexMeta } from "./indexStatus.js";

function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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

export async function startEvalRun(kbId, opts, ctx) {
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
    await ragMetaRepo.saveEvalRun(kbId, runId, run);

    setImmediate(() => {
        void runEvalAsync(kbId, runId, opts, ctx).catch((err) => {
            console.error(`[rag/eval] run ${runId} failed:`, err);
        });
    });
    return runId;
}

async function runEvalAsync(kbId, runId, opts, ctx) {
    const readRun = async () => ragMetaRepo.getEvalRun(kbId, runId);
    const writeRun = async (data) => ragMetaRepo.saveEvalRun(kbId, runId, data);

    let run = await readRun();
    run.status = "running";
    run.updated_at = nowIso();
    await writeRun(run);

    const store = ctx.getRagQuestionsStore(kbId);
    const doc = await store.getDocument();
    const meta = await readIndexMeta(ctx.settings.filesRoot, kbId);
    const runtime = await ctx.getRuntimeConfig(kbId);
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
        run = await readRun();
        run.results = results;
        run.summary = summarize(results);
        run.updated_at = nowIso();
        await writeRun(run);
    }

    run = await readRun();
    run.status = "completed";
    run.completed_at = nowIso();
    run.summary = summarize(results);
    run.updated_at = nowIso();
    await writeRun(run);
}

export async function getEvalRun(kbId, runId) {
    return ragMetaRepo.getEvalRun(kbId, runId);
}

export async function listEvalRuns(kbId, limit = 10) {
    return ragMetaRepo.listEvalRuns(kbId, limit);
}
