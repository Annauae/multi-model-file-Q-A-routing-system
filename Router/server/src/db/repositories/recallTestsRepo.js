import { query, withTransaction } from "../pool.js";

export async function getRecallTests(kbType, kbId) {
    const r = await query(
        `SELECT row_id, question, recalled, run_at, last_top_id, last_confidence, notes, match_profile_id, model_label
         FROM recall_tests WHERE kb_type = $1 AND kb_id = $2 ORDER BY sort_order, row_id`,
        [kbType, kbId],
    );
    return {
        items: r.rows.map((row) => ({
            id: row.row_id,
            question: row.question ?? "",
            recalled: row.recalled ?? "",
            run_at: row.run_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? row.run_at ?? undefined,
            last_top_id: row.last_top_id ?? undefined,
            last_confidence: row.last_confidence ?? undefined,
            notes: row.notes ?? undefined,
            match_profile_id: row.match_profile_id ?? undefined,
            model_label: row.model_label ?? undefined,
        })),
    };
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
            await client.query(
                `INSERT INTO recall_tests (kb_type, kb_id, row_id, question, recalled, run_at, last_top_id, last_confidence, notes, match_profile_id, model_label, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    kbType,
                    kbId,
                    rowId,
                    String(row.question ?? ""),
                    String(row.recalled ?? ""),
                    row.run_at ? row.run_at : null,
                    row.last_top_id ?? null,
                    row.last_confidence ?? null,
                    row.notes ?? null,
                    row.match_profile_id ?? null,
                    row.model_label ?? null,
                    order++,
                ],
            );
        }
        return getRecallTests(kbType, kbId);
    });
}
