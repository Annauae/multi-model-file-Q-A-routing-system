import { query, withTransaction } from "../pool.js";
import { nowIso } from "../utils.js";

export function validateItems(items) {
    const seen = new Set();
    const out = [];
    for (const raw of items) {
        const itemId = String(raw.id ?? "").trim();
        const question = String(raw.question ?? "").trim();
        const answer = String(raw.answer ?? "").trim();
        if (!itemId)
            throw new Error("id 不能为空");
        if (seen.has(itemId))
            throw new Error(`id 重复: ${itemId}`);
        if (!question)
            throw new Error(`question 不能为空: ${itemId}`);
        if (!answer)
            throw new Error(`answer 不能为空: ${itemId}`);
        seen.add(itemId);
        let variants = raw.variants;
        if (!Array.isArray(variants))
            variants = [];
        const normVariants = variants.map((v) => String(v).trim()).filter(Boolean);
        let enabled = raw.enabled;
        if (typeof enabled !== "boolean")
            enabled = true;
        out.push({
            id: itemId,
            question,
            variants: normVariants,
            answer,
            enabled,
            updated_at: String(raw.updated_at ?? "").trim() || nowIso(),
        });
    }
    return out;
}

function rowToItem(row) {
    return {
        id: row.item_id,
        question: row.question,
        variants: Array.isArray(row.variants) ? row.variants.map(String) : [],
        answer: row.answer,
        enabled: row.enabled !== false,
        updated_at: row.updated_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.updated_at ?? ""),
    };
}

export async function ensureQaDocument(kbType, kbId) {
    await query(
        `INSERT INTO qa_documents (kb_type, kb_id, version, updated_at) VALUES ($1, $2, 1, NOW())
         ON CONFLICT (kb_type, kb_id) DO NOTHING`,
        [kbType, kbId],
    );
}

export async function getDocument(kbType, kbId) {
    await ensureQaDocument(kbType, kbId);
    const ver = await query(
        "SELECT version FROM qa_documents WHERE kb_type = $1 AND kb_id = $2",
        [kbType, kbId],
    );
    const version = Number(ver.rows[0]?.version ?? 1) || 1;
    const r = await query(
        `SELECT item_id, question, variants, answer, enabled, updated_at
         FROM qa_items WHERE kb_type = $1 AND kb_id = $2 ORDER BY item_id`,
        [kbType, kbId],
    );
    return { version, items: r.rows.map(rowToItem) };
}

export async function replaceAll(kbType, kbId, version, items) {
    const validated = validateItems(items);
    return withTransaction(async (client) => {
        await client.query(
            `INSERT INTO qa_documents (kb_type, kb_id, version, updated_at) VALUES ($1, $2, $3, NOW())
             ON CONFLICT (kb_type, kb_id) DO UPDATE SET version = $3, updated_at = NOW()`,
            [kbType, kbId, Math.max(1, version)],
        );
        await client.query("DELETE FROM qa_items WHERE kb_type = $1 AND kb_id = $2", [kbType, kbId]);
        for (const item of validated) {
            await client.query(
                `INSERT INTO qa_items (kb_type, kb_id, item_id, question, variants, answer, enabled, updated_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz)`,
                [kbType, kbId, item.id, item.question, JSON.stringify(item.variants), item.answer, item.enabled, item.updated_at],
            );
        }
        return { version: Math.max(1, version), items: validated };
    });
}

export async function upsertItem(kbType, kbId, item) {
    const validated = validateItems([item])[0];
    validated.updated_at = nowIso();
    await ensureQaDocument(kbType, kbId);
    await query(
        `INSERT INTO qa_items (kb_type, kb_id, item_id, question, variants, answer, enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz)
         ON CONFLICT (kb_type, kb_id, item_id) DO UPDATE SET
           question = EXCLUDED.question,
           variants = EXCLUDED.variants,
           answer = EXCLUDED.answer,
           enabled = EXCLUDED.enabled,
           updated_at = EXCLUDED.updated_at`,
        [kbType, kbId, validated.id, validated.question, JSON.stringify(validated.variants), validated.answer, validated.enabled, validated.updated_at],
    );
    return validated;
}

export async function deleteItem(kbType, kbId, itemId) {
    const r = await query(
        `DELETE FROM qa_items WHERE kb_type = $1 AND kb_id = $2 AND item_id = $3
         RETURNING item_id, question, variants, answer, enabled, updated_at`,
        [kbType, kbId, itemId],
    );
    if (!r.rows.length)
        throw new Error("item_id 不存在");
    return rowToItem(r.rows[0]);
}

export async function getItem(kbType, kbId, itemId) {
    const r = await query(
        `SELECT item_id, question, variants, answer, enabled, updated_at
         FROM qa_items WHERE kb_type = $1 AND kb_id = $2 AND item_id = $3`,
        [kbType, kbId, itemId],
    );
    return r.rows.length ? rowToItem(r.rows[0]) : null;
}

export async function getItemsHashSource(kbType, kbId) {
    const doc = await getDocument(kbType, kbId);
    return JSON.stringify({ version: doc.version, items: doc.items });
}
