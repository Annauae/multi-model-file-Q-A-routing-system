import type { QAItem, QuestionsDocument } from "../types.js";
export declare class QuestionsStore {
    readonly filePath: string;
    readonly kbId: string;
    private onChange?;
    private cache;
    constructor(filePath: string, kbId: string, onChange?: ((kbId: string) => void) | undefined);
    static open(filePath: string, kbId: string, onChange?: (kbId: string) => void): QuestionsStore;
    private save;
    getDocument(): QuestionsDocument;
    replaceAll(version: number, items: Record<string, unknown>[]): QuestionsDocument;
    getItem(itemId: string): QAItem | null;
    upsertItem(item: Record<string, unknown>): QAItem;
    deleteItem(itemId: string): QAItem;
    get sourceMtime(): number;
}
