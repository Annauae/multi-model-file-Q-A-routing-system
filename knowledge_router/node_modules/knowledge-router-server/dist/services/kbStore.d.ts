export declare class KbStore {
    private filePath;
    private cache;
    constructor(filePath: string);
    private save;
    getAll(): Record<string, Record<string, unknown>>;
    get(kbId: string): Record<string, unknown> | null;
    nextAvailableKbId(): string;
    createKb(kbId: string, name: string): Record<string, unknown>;
    deleteKb(kbId: string): Record<string, unknown>;
    renameKb(kbId: string, name: string): Record<string, unknown>;
    deleteKbFiles(kbId: string, filesRoot: string): void;
}
