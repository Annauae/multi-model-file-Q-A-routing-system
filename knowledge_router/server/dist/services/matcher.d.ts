import type { QAItem } from "../types.js";
export declare const DEFAULT_MATCH_PROMPT_ZH = "\u4F60\u662F\u95EE\u9898\u5339\u914D\u5668\uFF0C\u4E0D\u662F\u56DE\u7B54\u5668\u3002\n\u6839\u636E\u7528\u6237\u95EE\u9898\uFF0C\u4ECE\u3010\u6807\u51C6\u95EE\u9898\u5217\u8868\u3011\u4E2D\u9009\u51FA\u8BED\u4E49\u6700\u63A5\u8FD1\u7684\u4E00\u9879\u3002\n\u5217\u8868\u4E2D\u540C\u4E00 id \u53EF\u80FD\u51FA\u73B0\u591A\u884C\uFF08\u6807\u51C6\u95EE\u9898 + \u5176\u4ED6\u95EE\u6CD5\uFF09\uFF0C\u547D\u4E2D\u4EFB\u610F\u4E00\u884C\u90FD\u8F93\u51FA\u8BE5 id\u3002\n\u53EA\u8F93\u51FA\u8BE5\u9879\u7684 id\uFF08\u5982 q001\uFF09\uFF1B\u65E0\u6CD5\u5339\u914D\u5219\u53EA\u8F93\u51FA NONE\u3002\n\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u4ED6\u5B57\u7B26\u3001\u6807\u70B9\u3001\u6362\u884C\u6216\u89E3\u91CA\u3002";
export declare const DEFAULT_CONFIDENCE_MATCH_PROMPT_ZH = "\u4F60\u662F\u95EE\u9898\u5339\u914D\u5668\uFF0C\u4E0D\u662F\u56DE\u7B54\u5668\u3002\n\u6839\u636E\u7528\u6237\u95EE\u9898\uFF0C\u4ECE\u3010\u6807\u51C6\u95EE\u9898\u5217\u8868\u3011\u4E2D\u627E\u51FA\u8BED\u4E49\u6700\u63A5\u8FD1\u7684\u82E5\u5E72\u9879\uFF08\u6700\u591A {top_k} \u9879\uFF09\u3002\n\u5217\u8868\u4E2D\u540C\u4E00 id \u53EF\u80FD\u51FA\u73B0\u591A\u884C\uFF08\u6807\u51C6\u95EE\u9898 + \u5176\u4ED6\u95EE\u6CD5\uFF09\uFF0C\u547D\u4E2D\u4EFB\u610F\u4E00\u884C\u90FD\u8BA1\u5165\u8BE5 id\u3002\n\n\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u6309 confidence \u4ECE\u9AD8\u5230\u4F4E\u6392\u5217\uFF0C\u6BCF\u9879\u683C\u5F0F\uFF1A{\"id\":\"q001\",\"confidence\":0.95}\nconfidence \u4E3A 0~1 \u4E4B\u95F4\u7684\u5C0F\u6570\uFF0C\u8868\u793A\u5339\u914D\u7F6E\u4FE1\u5EA6\uFF1B\u540C\u4E00 id \u53EA\u51FA\u73B0\u4E00\u6B21\u3002\n\u82E5\u65E0\u4EFB\u4F55\u53EF\u5339\u914D\u9879\uFF0C\u8F93\u51FA []\u3002\n\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u4ED6\u5B57\u7B26\u3001markdown \u4EE3\u7801\u5757\u6216\u89E3\u91CA\u3002";
export declare const NONE_SENTINEL = "NONE";
export declare function defaultConfidenceMatchPrompt(topK?: number): string;
export declare function defaultClarificationQuestion(): string;
export declare function iterQuestionPromptLines(item: QAItem): string[];
export declare function buildQuestionListSection(enabledItems: QAItem[]): string;
export declare function countQuestionPromptLines(enabledItems: QAItem[]): number;
export declare function buildConfidenceSystemPrompt(matchPrompt: string, enabledItems: QAItem[], topK?: number): string;
export declare function buildMatchMessages(systemPrompt: string, userQuestion: string): {
    role: string;
    content: string;
}[];
declare function normalizeOutput(raw: string): string;
export declare function parseConfidenceRaw(raw: string, validIds: Set<string>, topK?: number): {
    candidates: {
        id: string;
        confidence: number;
    }[];
    rawOutput: string;
};
export { normalizeOutput, NONE_SENTINEL as noneSentinel };
