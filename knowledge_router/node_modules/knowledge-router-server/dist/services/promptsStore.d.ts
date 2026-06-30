import type { GlobalPrompts } from "../types.js";
export declare class PromptsStore {
    private filePath;
    private onChange?;
    private data;
    constructor(filePath: string, onChange?: (() => void) | undefined);
    static open(filePath: string, onChange?: () => void): PromptsStore;
    private loadOrSeed;
    private save;
    get(): GlobalPrompts;
    set(patch: Partial<GlobalPrompts>): GlobalPrompts;
    effectiveConfidencePrompt(): string;
    effectiveFaqPrompt(): string;
    effectivePdfVlmPrompt(): string;
}
