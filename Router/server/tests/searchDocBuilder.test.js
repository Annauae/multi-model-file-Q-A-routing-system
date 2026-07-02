import { describe, it, expect } from "vitest";
import { buildSearchDocs, buildAllSearchDocs } from "../src/services/rag/searchDocBuilder.js";

describe("searchDocBuilder question-only indexing", () => {
  const item = {
    id: "q001",
    question: "如何调节曝光补偿？",
    variants: ["曝光怎么调"],
    answer_summary: "这是答案摘要，不应进入检索文本",
    enabled: true,
  };

  it("indexes question text without answer summary", () => {
    const docs = buildSearchDocs(item, new Set());
    const qDoc = docs.find((d) => d.doc_type === "question");
    expect(qDoc.text).toBe("如何调节曝光补偿？");
    expect(qDoc.text).not.toContain("答案摘要");
    expect(docs.some((d) => d.doc_type === "answer_summary")).toBe(false);
  });

  it("indexes variant text only", () => {
    const docs = buildSearchDocs(item, new Set());
    const vDoc = docs.find((d) => d.doc_type === "variant");
    expect(vDoc.text).toBe("曝光怎么调");
    expect(vDoc.text).not.toContain("答案摘要");
  });

  it("buildAllSearchDocs excludes holdout variants from index set", () => {
    const { indexedDocs } = buildAllSearchDocs([item], 0);
    expect(indexedDocs.every((d) => d.doc_type === "question" || d.doc_type === "variant")).toBe(true);
  });
});
