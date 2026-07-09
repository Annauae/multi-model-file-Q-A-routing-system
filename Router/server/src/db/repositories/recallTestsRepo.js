import { query, withTransaction } from "../pool.js";

function pickRunData(row) {
    const runData = {};
    if (Array.isArray(row.answers) && row.answers.length)
        runData.answers = row.answers;
    if (Array.isArray(row.candidates) && row.candidates.length)
        runData.candidates = row.candidates;
    if (row.timings)
        runData.timings = row.timings;
    if (Array.isArray(row.rag_sources) && row.rag_sources.length)
        runData.rag_sources = row.rag_sources;
    if (row.rag_answer)
        runData.rag_answer = row.rag_answer;
    if (row.rag_mode)
        runData.rag_mode = row.rag_mode;
    if (row.expected_id)
        runData.expected_id = row.expected_id;
    return runData;
}

function mergeRunData(row) {
    const runData = row.run_data && typeof row.run_data === "object" ? row.run_data : {};
    return {
        id: row.row_id,
        question: row.question ?? "",
        recalled: row.recalled ?? "",
        run_at: row.run_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? row.run_at ?? undefined,
        last_top_id: row.last_top_id ?? undefined,
        last_confidence: row.last_confidence ?? undefined,
        notes: row.notes ?? undefined,
        match_profile_id: row.match_profile_id ?? undefined,
        model_label: row.model_label ?? undefined,
        answers: runData.answers ?? [],
        candidates: runData.candidates ?? [],
        timings: runData.timings ?? undefined,
        rag_sources: runData.rag_sources ?? [],
        rag_answer: runData.rag_answer ?? "",
        rag_mode: runData.rag_mode ?? "",
        expected_id: runData.expected_id ?? undefined,
    };
}

function resolveTopMeta(row) {
    const topLlm = Array.isArray(row.answers) ? row.answers[0] : undefined;
    const topRag = Array.isArray(row.rag_sources) ? row.rag_sources[0] : undefined;
    const lastTopId = row.last_top_id ?? topRag?.id ?? topLlm?.id ?? null;
    const lastConfidence = row.last_confidence
        ?? topRag?.rerank_score
        ?? topRag?.rrf_score
        ?? topLlm?.confidence
        ?? null;
    return { lastTopId, lastConfidence };
}

export async function getRecallTests(kbType, kbId) {
    const r = await query(
        `SELECT row_id, question, recalled, run_at, last_top_id, last_confidence, notes, match_profile_id, model_label, run_data
         FROM recall_tests WHERE kb_type = $1 AND kb_id = $2 ORDER BY sort_order, row_id`,
        [kbType, kbId],
    );
    return { items: r.rows.map(mergeRunData) };
}

export async function replaceRecallTests(kbType, kbId, body) {
    const items = Array.isArray(body?.items) ? body.items : [];
    return withTransaction(async (client) => {
        await client.query("DELETE FROM recall_tests WHERE kb_type = $1 AND kb_id = $2", [kbType, kbId]);
        let order = 0;
        for (const row of items) {
            const rowId = String(row.id ?? "").trim();
            if (!rowId)
                continue;
            const { lastTopId, lastConfidence } = resolveTopMeta(row);
            const runData = pickRunData(row);
            await client.query(
                `INSERT INTO recall_tests (
                    kb_type, kb_id, row_id, question, recalled, run_at, last_top_id, last_confidence,
                    notes, match_profile_id, model_label, sort_order, run_data
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                    kbType,
                    kbId,
                    rowId,
                    String(row.question ?? ""),
                    String(row.recalled ?? ""),
                    row.run_at ? row.run_at : null,
                    lastTopId,
                    lastConfidence,
                    row.notes ?? null,
                    row.match_profile_id ?? null,
                    row.model_label ?? null,
                    order++,
                    JSON.stringify(runData),
                ],
            );
        }
        return getRecallTests(kbType, kbId);
    });
}
