import { query } from "../pool.js";
import { nowIso } from "../utils.js";

export async function getRuntimeConfig(kbId) {
    const r = await query("SELECT config FROM rag_runtime_configs WHERE kb_id = $1", [kbId]);
    return r.rows[0]?.config ?? null;
}

export async function saveRuntimeConfig(kbId, config) {
    const now = nowIso();
    await query(
        `INSERT INTO rag_runtime_configs (kb_id, config, updated_at) VALUES ($1, $2::jsonb, $3::timestamptz)
         ON CONFLICT (kb_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
        [kbId, JSON.stringify(config), now],
    );
    return config;
}

export async function getIndexMeta(kbId) {
    const r = await query("SELECT meta FROM rag_index_meta WHERE kb_id = $1", [kbId]);
    return r.rows[0]?.meta ?? null;
}

export async function saveIndexMeta(kbId, meta) {
    const now = nowIso();
    await query(
        `INSERT INTO rag_index_meta (kb_id, meta, updated_at) VALUES ($1, $2::jsonb, $3::timestamptz)
         ON CONFLICT (kb_id) DO UPDATE SET meta = EXCLUDED.meta, updated_at = EXCLUDED.updated_at`,
        [kbId, JSON.stringify(meta), now],
    );
}

export async function hasDataMigration(name) {
    const r = await query("SELECT 1 FROM data_migrations WHERE name = $1", [name]);
    return r.rows.length > 0;
}

export async function markDataMigration(name) {
    await query(
        `INSERT INTO data_migrations (name, completed_at) VALUES ($1, NOW()) ON CONFLICT (name) DO NOTHING`,
        [name],
    );
}
