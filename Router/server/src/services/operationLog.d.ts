export interface LogEntry {
    ts: string;
    level: string;
    module: string;
    action: string;
    kb_id: string;
    detail: string;
    kind: string;
    extra?: Record<string, unknown>;
}
export declare class OperationLog {
    private maxEntries;
    private persistPath?;
    private entries;
    constructor(maxEntries?: number, persistPath?: string | undefined);
    private loadPersisted;
    private normalizeDetail;
    append(opts: {
        level?: string;
        module?: string;
        action?: string;
        kb_id?: string;
        detail?: string;
        kind?: string;
        extra?: Record<string, unknown>;
    }): LogEntry;
    listEntries(opts?: {
        limit?: number;
        module?: string;
        kb_id?: string;
        level?: string;
    }): LogEntry[];
    clear(): number;
}
