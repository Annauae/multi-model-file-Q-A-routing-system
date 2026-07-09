import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDatabase, teardownTestDatabase } from "./dbSetup.js";
import * as recallRepo from "../src/db/repositories/recallTestsRepo.js";

describe("recallTestsRepo", () => {
    beforeAll(async () => {
        await setupTestDatabase();
    });

    afterAll(async () => {
        await teardownTestDatabase();
    });

    it("roundtrips run results in run_data", async () => {
        const items = [{
            id: "r_test_1",
            question: "怎么调光圈？",
            recalled: "yes",
            run_at: "2026-06-29T07:49:39.245Z",
            answers: [{
                id: "q143",
                confidence: 0.95,
                question: "光圈优先自动模式（A）如何调整光圈？",
                answer: "旋转副指令拨盘可调整光圈。",
            }],
            candidates: [{ id: "q143", confidence: 0.95, question: "光圈优先自动模式（A）如何调整光圈？" }],
            timings: { total_ms: 1235, tokens: { total_tokens: 100 } },
            match_profile_id: "p_test",
            model_label: "test-model",
        }];

        await recallRepo.replaceRecallTests("llm", "1", { items });
        const doc = await recallRepo.getRecallTests("llm", "1");
        expect(doc.items).toHaveLength(1);
        expect(doc.items[0].answers).toHaveLength(1);
        expect(doc.items[0].answers[0].answer).toContain("副指令拨盘");
        expect(doc.items[0].timings?.total_ms).toBe(1235);
        expect(doc.items[0].last_top_id).toBe("q143");
        expect(doc.items[0].last_confidence).toBe(0.95);
    });

    it("roundtrips RAG run results", async () => {
        const items = [{
            id: "r_rag_1",
            question: "曝光补偿？",
            recalled: "no",
            expected_id: "q001",
            rag_sources: [{ id: "q002", rerank_score: 0.88, content: "片段" }],
            rag_answer: "RAG 合成回答",
            rag_mode: "hybrid",
        }];

        await recallRepo.replaceRecallTests("rag", "1", { items });
        const doc = await recallRepo.getRecallTests("rag", "1");
        expect(doc.items[0].rag_sources).toHaveLength(1);
        expect(doc.items[0].rag_answer).toBe("RAG 合成回答");
        expect(doc.items[0].expected_id).toBe("q001");
        expect(doc.items[0].last_top_id).toBe("q002");
    });
});
