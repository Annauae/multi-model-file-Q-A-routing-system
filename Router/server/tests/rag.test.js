import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createApp, createAppContext } from "../src/app.js";

let tmpRoot = "";
/** @type {ReturnType<typeof createApp>} */
let app;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "router-rag-test-"));
  const configPath = path.join(tmpRoot, "config");
  const filesRoot = path.join(tmpRoot, "files");
  fs.mkdirSync(configPath, { recursive: true });
  fs.mkdirSync(filesRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configPath, "knowledge_bases.json"),
    JSON.stringify({
      "1": { name: "测试", match_prompt: "", status: "ready", created_at: "2026-06-23T00:00:00Z", updated_at: "2026-06-23T00:00:00Z" },
    }),
  );
  const qdir = path.join(filesRoot, "kb_1");
  fs.mkdirSync(path.join(qdir, "rag"), { recursive: true });
  fs.writeFileSync(
    path.join(qdir, "questions.json"),
    JSON.stringify({
      version: 1,
      items: [{ id: "q001", question: "曝光补偿怎么用？", variants: [], answer: "预存回答内容", enabled: true, updated_at: "2026-06-23T00:00:00Z" }],
    }),
  );
  fs.writeFileSync(
    path.join(qdir, "rag", "questions.json"),
    JSON.stringify({
      version: 1,
      items: [{ id: "q001", question: "RAG 曝光补偿", variants: ["怎么调曝光"], answer: "RAG 预存回答", enabled: true, updated_at: "2026-06-23T00:00:00Z" }],
    }),
  );
  fs.writeFileSync(
    path.join(configPath, "rag_knowledge_bases.json"),
    JSON.stringify({}),
  );
  fs.writeFileSync(path.join(configPath, "match_profiles.json"), JSON.stringify({ default_id: "default", profiles: [{ id: "default", name: "default", model: "test", api_base_url: "http://localhost", api_key: "test" }] }));
  fs.writeFileSync(path.join(configPath, "models.json"), JSON.stringify({ match: { model: "test", api_base_url: "http://localhost", api_key: "test" }, import: { model: "test", api_base_url: "http://localhost", api_key: "test" }, pdf_vlm: { model: "test", api_base_url: "http://localhost", api_key: "test" } }));
  fs.writeFileSync(path.join(configPath, "prompts.json"), JSON.stringify({ confidence_match_prompt: "test", faq_generation_prompt: "test", pdf_vlm_prompt: "test" }));

  process.env.DATA_ROOT = tmpRoot;
  process.env.FILES_ROOT = filesRoot;
  process.env.KB_CONFIG_PATH = path.join(configPath, "knowledge_bases.json");
  process.env.RAG_KB_CONFIG_PATH = path.join(configPath, "rag_knowledge_bases.json");
  process.env.MOCK_LLM = "1";
  process.env.MOCK_WEAVIATE = "1";
  process.env.API_KEY = "test";

  const ctx = createAppContext();
  app = createApp(ctx);
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
  it("lists rag knowledge bases after legacy migration", async () => {
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

describe("rag eval", () => {
  it("starts eval run and returns status", async () => {
    const start = await request(app).post("/rag/eval/run").send({ kb_id: "1", size: 10, mode: "question", top_k: 3 });
    expect(start.status).toBe(200);
    expect(start.body.run_id).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));
    const run = await request(app).get(`/rag/eval/runs/${start.body.run_id}?kb_id=1`);
    expect(run.status).toBe(200);
    expect(["queued", "running", "completed"].includes(run.body.status)).toBe(true);
  });
});
