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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
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
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(
    path.join(qdir, "questions.json"),
    JSON.stringify({
      version: 1,
      items: [{ id: "q001", question: "曝光补偿怎么用？", variants: [], answer: "预存回答内容", enabled: true, updated_at: "2026-06-23T00:00:00Z" }],
    }),
  );
  fs.writeFileSync(path.join(configPath, "match_profiles.json"), JSON.stringify({ default_id: "default", profiles: [{ id: "default", name: "default", model: "test", api_base_url: "http://localhost", api_key: "test" }] }));
  fs.writeFileSync(path.join(configPath, "models.json"), JSON.stringify({ slots: { match: { model: "test", api_base_url: "http://localhost", api_key: "test" }, import: { model: "test", api_base_url: "http://localhost", api_key: "test" }, pdf_vlm: { model: "test", api_base_url: "http://localhost", api_key: "test" } } }));
  fs.writeFileSync(path.join(configPath, "prompts.json"), JSON.stringify({ confidence_match: "test", faq_generation: "test", pdf_vlm: "test" }));

  process.env.DATA_ROOT = tmpRoot;
  process.env.FILES_ROOT = filesRoot;
  process.env.KB_CONFIG_PATH = path.join(configPath, "knowledge_bases.json");
  process.env.MOCK_LLM = "1";
  process.env.API_KEY = "test";

  const ctx = createAppContext();
  app = createApp(ctx);
});

describe("health", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("knowledge-bases", () => {
  it("lists kbs", async () => {
    const res = await request(app).get("/knowledge-bases");
    expect(res.status).toBe(200);
    expect(res.body.items.some((x) => x.kb_id === "1")).toBe(true);
  });
});

describe("ask confidence", () => {
  it("returns answer", async () => {
    const res = await request(app).post("/ask/confidence").send({ question: "曝光补偿", kb_id: "1", top_k: 3 });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("预存回答内容");
    expect(res.body.match.candidates[0].id).toBe("q001");
  });

  it("stream returns candidates and done", async () => {
    const res = await request(app)
      .post("/ask/confidence/stream")
      .send({ question: "曝光补偿", kb_id: "1", top_k: 3 });
    expect(res.status).toBe(200);
    expect(res.text).toContain("event: candidates");
    expect(res.text).toContain("event: done");
    expect(res.text).toContain("q001");
  });
});

describe("match profiles", () => {
  it("returns profiles", async () => {
    const res = await request(app).get("/settings/match-profiles");
    expect(res.status).toBe(200);
    expect(res.body.profiles.length).toBeGreaterThan(0);
  });
});
