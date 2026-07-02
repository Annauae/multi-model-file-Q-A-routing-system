export class RagLogSink {
    opLog;
    module;
    kbId;

    constructor(opLog, module = "rag-debug", kbId = "") {
        this.opLog = opLog;
        this.module = module;
        this.kbId = kbId;
    }

    log(line, kind = "log", action = "step") {
        this.opLog?.append({
            module: this.module,
            action,
            kb_id: this.kbId,
            detail: line,
            kind,
        });
    }

    step(line) {
        this.log(line, "step", "step");
    }

    timing(label, ms) {
        this.log(`[timing] ${label}=${Number(ms).toFixed(1)}ms`, "timing", "timing");
    }

    result(label, value) {
        this.log(`[result] ${label}=${value}`, "result", "result");
    }
}

export function formatRagSearchSummary(results) {
    if (!results?.length)
        return "0 hits";
    return results.slice(0, 5).map((r, i) =>
        `#${i + 1} ${r.id} rerank=${Number(r.rerank_score || 0).toFixed(3)} rrf=${Number(r.rrf_score || 0).toFixed(3)}`,
    ).join(" | ");
}
