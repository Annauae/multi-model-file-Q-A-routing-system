import type { Settings } from "../config.js";
export declare class LLMError extends Error {
    constructor(message: string);
}
export interface TokenUsageResult {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}
export declare function tokenUsageToDict(u: TokenUsageResult): TokenUsageResult;
export interface ChatMessage {
    role: string;
    content: string | Array<Record<string, unknown>>;
}
export declare class LLMClient {
    private settings;
    private apiBaseUrl;
    private apiKey;
    private enableThinking;
    private client;
    constructor(settings: Settings, apiBaseUrl?: string, apiKey?: string, enableThinking?: boolean | null);
    withCredentials(opts: {
        api_base_url: string;
        api_key: string;
        enable_thinking?: boolean | null;
    }): LLMClient;
    private isOllama;
    private ollamaRootUrl;
    private useOllamaNative;
    private getOpenAI;
    private toOpenAIMessages;
    private buildExtraBody;
    private ollamaMessages;
    private ollamaPost;
    private ollamaStream;
    private mockMatch;
    private mockConfidence;
    chat(opts: {
        model: string;
        messages: ChatMessage[];
        max_tokens?: number;
        temperature?: number;
    }): Promise<[string, TokenUsageResult]>;
    chatStream(opts: {
        model: string;
        messages: ChatMessage[];
        max_tokens?: number;
        temperature?: number;
        mock_mode?: "match" | "confidence";
        usage_out?: TokenUsageResult[];
    }): AsyncGenerator<string>;
}
