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
    normalizeDetail(detail, module = "") {
        const maxLen = String(module).startsWith("rag") ? 4000 : MAX_DETAIL_LEN;
        if (detail.length <= maxLen)
            return detail;
        return `${detail.slice(0, maxLen)}…（已截断，共 ${detail.length} 字符）`;
    }
    append(opts) {
        const entry = {
            ts: nowIso(),
            level: opts.level ?? "info",
            module: opts.module ?? "system",
            action: opts.action ?? "",
            kb_id: opts.kb_id ?? "",
            detail: this.normalizeDetail(opts.detail ?? "", opts.module ?? ""),
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
        const modulesRaw = opts.modules ?? opts.module ?? "";
        if (modulesRaw) {
            const moduleList = String(modulesRaw).split(",").map((m) => m.trim()).filter(Boolean);
            if (moduleList.length === 1)
                items = items.filter((e) => e.module === moduleList[0]);
            else if (moduleList.length > 1)
                items = items.filter((e) => moduleList.includes(e.module));
        }
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
