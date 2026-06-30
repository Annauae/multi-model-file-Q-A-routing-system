import type { KbMemoryIndex, QAItem } from "../types.js";
import { KbStore } from "./kbStore.js";
import { PromptsStore } from "./promptsStore.js";
import { QuestionsStore } from "./questionsStore.js";
export declare class QuestionsCache {
    private kbStore;
    private filesRoot;
    private confidenceTopK;
    private promptsStore?;
    private indexes;
    private stores;
    constructor(kbStore: KbStore, filesRoot: string, confidenceTopK?: number, promptsStore?: PromptsStore | undefined);
    private confidencePrompt;
    private storeFor;
    private buildIndex;
    loadKb(kbId: string): KbMemoryIndex;
    reloadKb(kbId: string): KbMemoryIndex;
    evictKb(kbId: string): void;
    loadAll(): void;
    reloadAll(): void;
    getIndex(kbId: string): KbMemoryIndex | undefined;
    getConfidenceSystemPrompt(kbId: string, topK?: number): string;
    getEnabledCount(kbId: string): number;
    resolveItem(kbId: string, matchedId: string): QAItem | null;
    store(kbId: string): QuestionsStore;
    previewConfidenceSystemPrompt(kbId: string, topK?: number): [string, string, number];
}
