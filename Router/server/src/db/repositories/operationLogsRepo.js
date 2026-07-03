import { query } from "../pool.js";
import { nowIso } from "../utils.js";

const MAX_DETAIL_LEN = 800;

function normalizeDetail(detail, module = "") {
    const maxLen = String(module).startsWith("rag") ? 4000 : MAX_DETAIL_LEN;
    if (detail.length <= maxLen)
        return detail;
    return `${detail.slice(0, maxLen)}…（已截断，共 ${detail.length} 字符）`;
}

export async function appendLog(opts) {
    const entry = {
        ts: nowIso(),
        level: opts.level ?? "info",
        module: opts.module ?? "system",
        action: opts.action ?? "",
        kb_id: opts.kb_id ?? "",
        detail: normalizeDetail(opts.detail ?? "", opts.module ?? ""),
        kind: opts.kind ?? "log",
        extra: opts.extra ?? null,
    };
    const r = await query(
        `INSERT INTO operation_logs (ts, level, module, action, kb_id, detail, kind, extra)
         VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING id, ts, level, module, action, kb_id, detail, kind, extra`,
        [entry.ts, entry.level, entry.module, entry.action, entry.kb_id, entry.detail, entry.kind, entry.extra ? JSON.stringify(entry.extra) : null],
    );
    const row = r.rows[0];
    const out = {
        ts: row.ts?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? entry.ts,
        level: row.level,
        module: row.module,
        action: row.action,
        kb_id: row.kb_id,
        detail: row.detail,
        kind: row.kind,
    };
    if (row.extra)
        out.extra = row.extra;
    return out;
}

export function appendLogAsync(opts) {
    void appendLog(opts).catch((err) => {
        console.error("[db] operation log append failed:", err);
    });
}

export async function listLogs(opts = {}) {
    const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
    const modulesRaw = opts.modules ?? opts.module ?? "";
    const params = [];
    const clauses = [];
    if (modulesRaw) {
        const moduleList = String(modulesRaw).split(",").map((m) => m.trim()).filter(Boolean);
        if (moduleList.length === 1) {
            params.push(moduleList[0]);
            clauses.push(`module = $${params.length}`);
        }
        else if (moduleList.length > 1) {
            params.push(moduleList);
            clauses.push(`module = ANY($${params.length}::text[])`);
        }
    }
    if (opts.kb_id) {
        params.push(opts.kb_id);
        clauses.push(`kb_id = $${params.length}`);
    }
    if (opts.level) {
        params.push(opts.level);
        clauses.push(`level = $${params.length}`);
    }
    if (opts.since) {
        params.push(opts.since);
        clauses.push(`ts > $${params.length}::timestamptz`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const r = await query(
        `SELECT ts, level, module, action, kb_id, detail, kind, extra
         FROM operation_logs ${where}
         ORDER BY ts DESC
         LIMIT $${params.length}`,
        params,
    );
    return r.rows.map((row) => {
        const out = {
            ts: row.ts?.toISOString?.()?.replace(/\.\d{3}Z$/, "Z") ?? "",
            level: row.level,
            module: row.module,
            action: row.action,
            kb_id: row.kb_id,
            detail: row.detail,
            kind: row.kind,
        };
        if (row.extra)
            out.extra = row.extra;
        return out;
    }).reverse();
}
