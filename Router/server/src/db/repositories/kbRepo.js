import { query } from "../pool.js";
import { nowIso } from "../utils.js";

export async function getAllLlmKbs() {
    const r = await query(
        "SELECT kb_id, name, match_prompt, status, created_at, updated_at FROM llm_knowledge_bases ORDER BY kb_id",
    );
    const out = {};
    for (const row of r.rows) {
        out[row.kb_id] = {
            name: row.name,
            match_prompt: row.match_prompt,
            status: row.status,
            created_at: row.created_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.created_at),
            updated_at: row.updated_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.updated_at),
        };
    }
    return out;
}

export async function getLlmKb(kbId) {
    const r = await query(
        "SELECT kb_id, name, match_prompt, status, created_at, updated_at FROM llm_knowledge_bases WHERE kb_id = $1",
        [kbId],
    );
    if (!r.rows.length)
        return null;
    const row = r.rows[0];
    return {
        name: row.name,
        match_prompt: row.match_prompt,
        status: row.status,
        created_at: row.created_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.created_at),
        updated_at: row.updated_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.updated_at),
    };
}

export async function nextAvailableLlmKbId() {
    const r = await query("SELECT kb_id FROM llm_knowledge_bases WHERE kb_id ~ '^[0-9]+$'");
    const used = new Set(r.rows.map((row) => parseInt(row.kb_id, 10)));
    let n = 1;
    while (used.has(n))
        n++;
    return String(n);
}

export async function createLlmKb(kbId, name) {
    const now = nowIso();
    await query(
        `INSERT INTO llm_knowledge_bases (kb_id, name, match_prompt, status, created_at, updated_at)
         VALUES ($1, $2, '', 'ready', $3::timestamptz, $3::timestamptz)`,
        [kbId, name, now],
    );
    await query(
        `INSERT INTO qa_documents (kb_type, kb_id, version, updated_at) VALUES ('llm', $1, 1, NOW())
         ON CONFLICT (kb_type, kb_id) DO NOTHING`,
        [kbId],
    );
    return (await getLlmKb(kbId));
}

export async function deleteLlmKb(kbId) {
    const cfg = await getLlmKb(kbId);
    if (!cfg)
        throw new Error("kb_id 不存在");
    await query("DELETE FROM qa_items WHERE kb_type = 'llm' AND kb_id = $1", [kbId]);
    await query("DELETE FROM qa_documents WHERE kb_type = 'llm' AND kb_id = $1", [kbId]);
    await query("DELETE FROM recall_tests WHERE kb_type = 'llm' AND kb_id = $1", [kbId]);
    await query("DELETE FROM llm_knowledge_bases WHERE kb_id = $1", [kbId]);
    return cfg;
}

export async function renameLlmKb(kbId, name) {
    const newName = (name || "").trim();
    if (!newName)
        throw new Error("name 不能为空");
    const now = nowIso();
    const r = await query(
        "UPDATE llm_knowledge_bases SET name = $2, updated_at = $3::timestamptz WHERE kb_id = $1 RETURNING kb_id",
        [kbId, newName, now],
    );
    if (!r.rows.length)
        throw new Error("kb_id 不存在");
    return (await getLlmKb(kbId));
}

export async function getAllRagKbs() {
    const r = await query(
        "SELECT kb_id, name, status, created_at, updated_at FROM rag_knowledge_bases ORDER BY kb_id",
    );
    const out = {};
    for (const row of r.rows) {
        out[row.kb_id] = {
            name: row.name,
            status: row.status,
            created_at: row.created_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.created_at),
            updated_at: row.updated_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.updated_at),
        };
    }
    return out;
}

export async function getRagKb(kbId) {
    const r = await query(
        "SELECT kb_id, name, status, created_at, updated_at FROM rag_knowledge_bases WHERE kb_id = $1",
        [kbId],
    );
    if (!r.rows.length)
        return null;
    const row = r.rows[0];
    return {
        name: row.name,
        status: row.status,
        created_at: row.created_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.created_at),
        updated_at: row.updated_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(row.updated_at),
    };
}

export async function nextAvailableRagKbId() {
    const r = await query("SELECT kb_id FROM rag_knowledge_bases WHERE kb_id ~ '^[0-9]+$'");
    const used = new Set(r.rows.map((row) => parseInt(row.kb_id, 10)));
    let n = 1;
    while (used.has(n))
        n++;
    return String(n);
}

export async function createRagKb(kbId, name) {
    const now = nowIso();
    await query(
        `INSERT INTO rag_knowledge_bases (kb_id, name, status, created_at, updated_at)
         VALUES ($1, $2, 'ready', $3::timestamptz, $3::timestamptz)`,
        [kbId, name, now],
    );
    await query(
        `INSERT INTO qa_documents (kb_type, kb_id, version, updated_at) VALUES ('rag', $1, 1, NOW())
         ON CONFLICT (kb_type, kb_id) DO NOTHING`,
        [kbId],
    );
    return (await getRagKb(kbId));
}

export async function deleteRagKb(kbId) {
    const cfg = await getRagKb(kbId);
    if (!cfg)
        throw new Error("kb_id 不存在");
    await query("DELETE FROM rag_eval_runs WHERE kb_id = $1", [kbId]);
    await query("DELETE FROM rag_index_meta WHERE kb_id = $1", [kbId]);
    await query("DELETE FROM rag_runtime_configs WHERE kb_id = $1", [kbId]);
    await query("DELETE FROM qa_items WHERE kb_type = 'rag' AND kb_id = $1", [kbId]);
    await query("DELETE FROM qa_documents WHERE kb_type = 'rag' AND kb_id = $1", [kbId]);
    await query("DELETE FROM recall_tests WHERE kb_type = 'rag' AND kb_id = $1", [kbId]);
    await query("DELETE FROM rag_knowledge_bases WHERE kb_id = $1", [kbId]);
    return cfg;
}

export async function renameRagKb(kbId, name) {
    const newName = (name || "").trim();
    if (!newName)
        throw new Error("name 不能为空");
    const now = nowIso();
    const r = await query(
        "UPDATE rag_knowledge_bases SET name = $2, updated_at = $3::timestamptz WHERE kb_id = $1 RETURNING kb_id",
        [kbId, newName, now],
    );
    if (!r.rows.length)
        throw new Error("kb_id 不存在");
    return (await getRagKb(kbId));
}

export async function countLlmKbs() {
    const r = await query("SELECT COUNT(*)::int AS n FROM llm_knowledge_bases");
    return r.rows[0]?.n ?? 0;
}

export async function countAppSettings() {
    const r = await query("SELECT COUNT(*)::int AS n FROM app_settings");
    return r.rows[0]?.n ?? 0;
}
