import * as opRepo from "../repositories/operationLogsRepo.js";

export class OperationLog {
    append(opts) {
        opRepo.appendLogAsync(opts);
        return {
            ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            level: opts.level ?? "info",
            module: opts.module ?? "system",
            action: opts.action ?? "",
            kb_id: opts.kb_id ?? "",
            detail: opts.detail ?? "",
            kind: opts.kind ?? "log",
        };
    }

    async listEntries(opts = {}) {
        return opRepo.listLogs(opts);
    }
}
