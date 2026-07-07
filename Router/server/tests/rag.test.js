import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp, createAppContext } from "../src/app.js";
import { setupTestDatabase, teardownTestDatabase } from "./dbSetup.js";

/** @type {ReturnType<typeof createApp>} */
let app;

beforeAll(async () => {
  await setupTestDatabase();
  const ctx = await createAppContext();
  app = createApp(ctx);
});

afterAll(async () => {
  await teardownTestDatabase();
});

describe("rag health", () => {
  it("returns ok with mock weaviate", async () => {
    const res = await request(app).get("/rag/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.weaviate.mock).toBe(true);
  });
});

describe("rag knowledge bases", () => {
  it("lists rag knowledge bases", async () => {
    const res = await request(app).get("/rag/knowledge-bases");
    expect(res.status).toBe(200);
    expect(res.body.items.some((x) => x.kb_id === "1")).toBe(true);
  });
});

describe("rag questions CRUD", () => {
  it("reads rag questions", async () => {
    const res = await request(app).get("/rag/knowledge-bases/1/questions");
    expect(res.status).toBe(200);
    expect(res.body.items[0].id).toBe("q001");
  });

  it("creates rag item", async () => {
    const res = await request(app).post("/rag/knowledge-bases/1/questions/items").send({
      id: "q002",
      question: "新问题",
      variants: [],
      answer: "新答案",
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("q002");
  });
});

describe("rag import from llm", () => {
  it("imports from llm faq", async () => {
    const res = await request(app).post("/rag/knowledge-bases/1/import/from-llm").send({
      llm_kb_id: "1",
      append: false,
      auto_rebuild: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
  });
});

describe("llm import from rag", () => {
  it("imports from rag faq", async () => {
    const res = await request(app).post("/knowledge-bases/1/import/from-rag").send({
      rag_kb_id: "1",
      append: false,
      replace: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
  });
});

describe("rag index and chat", () => {
  it("rebuilds index", async () => {
    const res = await request(app).post("/rag/knowledge-bases/1/index/rebuild");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("search returns results", async () => {
    const res = await request(app).post("/rag/search").send({ query: "曝光", kb_id: "1", top_k: 3 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it("chat returns answer", async () => {
    const res = await request(app).post("/rag/chat").send({ query: "RAG 曝光", kb_id: "1" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBeTruthy();
  });
});

describe("import dual target", () => {
  it("commits to rag only", async () => {
    const res = await request(app).post("/knowledge-bases/1/import/commit").send({
      items: [{ question: "导入题", variants: ["变体"], answer: "导入答案", enabled: true }],
      append: true,
      targets: ["rag"],
      rag_kb_id: "1",
      auto_rebuild_rag: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.rag).toBe(1);
  });
});

describe("rag models settings", () => {
  it("returns rag model slots", async () => {
    const res = await request(app).get("/settings/rag-models");
    expect(res.status).toBe(200);
    expect(res.body.slots.embedding).toBeTruthy();
  });
});
