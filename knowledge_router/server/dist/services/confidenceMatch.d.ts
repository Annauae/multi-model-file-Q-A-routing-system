import type { Settings } from "../config.js";
import type { AskTimings, ConfidenceAskResponse, ConfidenceMatchResult } from "../types.js";
import { LLMClient } from "./llmClient.js";
import type { QuestionsCache } from "./questionsCache.js";
import type { OperationLog } from "./operationLog.js";
export declare class AskLogSink {
    private emit?;
    private opLog?;
    private module;
    private kbId;
    private entries;
    constructor(emit?: ((line: string, kind: string) => void) | undefined, opLog?: OperationLog | undefined, module?: string, kbId?: string);
    log(line: string, kind?: string): void;
}
export declare function runConfidenceMatch(opts: {
    question: string;
    kbId: string;
    topK: number;
    cache: QuestionsCache;
    llm: LLMClient;
    settings: Settings;
    logSink?: AskLogSink;
    matchModel?: string;
    maxTokens?: number;
    temperature?: number;
    abortSignal?: AbortSignal;
}): Promise<[ConfidenceMatchResult, AskTimings, string, {
    role: string;
    content: string;
}[], ConfidenceAskResponse]>;
export declare function sseEvent(event: string, data: unknown): string;
