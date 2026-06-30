import { LLMClient } from "./llmClient.js";
export declare function stripMdFrontmatter(text: string): string;
export declare function generateFaqQuestionsOnly(answerMd: string, llm: LLMClient, importModel: string, systemPrompt?: string): Promise<[{
    question: string;
    variants: string[];
}, {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}]>;
export declare function assignQuestionIds(items: Record<string, unknown>[], start?: number): Record<string, unknown>[];
