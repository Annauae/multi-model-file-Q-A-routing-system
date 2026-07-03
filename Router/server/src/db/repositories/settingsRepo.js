import { query } from "../pool.js";
import { nowIso } from "../utils.js";

export async function getSetting(key) {
    const r = await query("SELECT value, updated_at FROM app_settings WHERE key = $1", [key]);
    if (!r.rows.length)
        return null;
    return {
        value: r.rows[0].value,
        updated_at: r.rows[0].updated_at?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? String(r.rows[0].updated_at ?? ""),
    };
}

export async function setSetting(key, value) {
    const now = nowIso();
    await query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3::timestamptz)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(value), now],
    );
    return { value, updated_at: now };
}

export async function hasSetting(key) {
    const r = await query("SELECT 1 FROM app_settings WHERE key = $1", [key]);
    return r.rows.length > 0;
}
