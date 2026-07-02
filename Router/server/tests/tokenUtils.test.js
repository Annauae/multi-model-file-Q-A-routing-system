import { describe, expect, it } from "vitest";
import { estimateTextTokens, usageFromRerankInput, usageFromText } from "../src/services/rag/tokenUtils.js";

describe("tokenUtils", () => {
    it("estimates Chinese query tokens", () => {
        expect(estimateTextTokens("怎么调光圈")).toBeGreaterThanOrEqual(4);
    });

    it("aggregates rerank input tokens", () => {
        const usage = usageFromRerankInput("怎么调光圈", ["主问题：光圈\n答案摘要：调节光圈"]);
        expect(usage.total_tokens).toBeGreaterThan(8);
        expect(usage.prompt_tokens).toBe(usage.total_tokens);
    });

    it("builds generate usage with completion", () => {
        const usage = usageFromText("prompt text", { completion: 50 });
        expect(usage.total_tokens).toBe(usage.prompt_tokens + 50);
    });
});
