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

describe("logs", () => {
  it("lists logs", async () => {
    const res = await request(app).get("/logs?limit=10");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("DELETE /logs is not available", async () => {
    const res = await request(app).delete("/logs");
    expect(res.status).toBe(404);
  });
});
