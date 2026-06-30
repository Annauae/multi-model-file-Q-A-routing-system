import fs from "node:fs";
import path from "node:path";
const MAX_DETAIL_LEN = 800;
function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
export class OperationLog {
    maxEntries;
    persistPath;
    entries = [];
    constructor(maxEntries = 5000, persistPath) {
        this.maxEntries = maxEntries;
        this.persistPath = persistPath;
        if (this.persistPath) {
            const dir = path.dirname(this.persistPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            this.loadPersisted();
        }
    }
    loadPersisted() {
        if (!this.persistPath || !fs.existsSync(this.persistPath))
            return;
        try {
            const raw = fs.readFileSync(this.persistPath, "utf-8");
            for (const line of raw.split(/\r?\n/)) {
                const t = line.trim();
                if (!t)
                    continue;
                try {
                    const entry = JSON.parse(t);
                    if (entry && typeof entry === "object")
                        this.entries.push(entry);
                }
                catch {
                    /* skip bad line */
                }
            }
            if (this.entries.length > this.maxEntries) {
                this.entries = this.entries.slice(-this.maxEntries);
            }
        }
        catch {
            /* ignore */
        }
    }
    normalizeDetail(detail) {
        if (detail.length <= MAX_DETAIL_LEN)
            return detail;
        return `${detail.slice(0, MAX_DETAIL_LEN)}…（已截断，共 ${detail.length} 字符）`;
    }
    append(opts) {
        const entry = {
            ts: nowIso(),
            level: opts.level ?? "info",
            module: opts.module ?? "system",
            action: opts.action ?? "",
            kb_id: opts.kb_id ?? "",
            detail: this.normalizeDetail(opts.detail ?? ""),
            kind: opts.kind ?? "log",
        };
        if (opts.extra)
            entry.extra = opts.extra;
        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(-this.maxEntries);
        }
        if (this.persistPath) {
            fs.appendFileSync(this.persistPath, JSON.stringify(entry) + "\n", "utf-8");
        }
        return entry;
    }
    listEntries(opts = {}) {
        let limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
        let items = [...this.entries];
        if (opts.module)
            items = items.filter((e) => e.module === opts.module);
        if (opts.kb_id)
            items = items.filter((e) => e.kb_id === opts.kb_id);
        if (opts.level)
            items = items.filter((e) => e.level === opts.level);
        return items.slice(-limit);
    }
    clear() {
        const n = this.entries.length;
        this.entries = [];
        if (this.persistPath && fs.existsSync(this.persistPath)) {
            try {
                fs.writeFileSync(this.persistPath, "", "utf-8");
            }
            catch {
                /* ignore */
            }
        }
        return n;
    }
}
