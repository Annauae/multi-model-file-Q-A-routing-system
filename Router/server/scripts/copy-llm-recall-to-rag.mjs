#!/usr/bin/env node
/**
 * 将问答模型（LLM）召回测试问题复制到 RAG 知识库
 * 用法: node scripts/copy-llm-recall-to-rag.mjs [llmKbId] [ragKbId]
 * 默认均为 1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../..");
const FILES_ROOT = path.resolve(process.env.FILES_ROOT || path.join(APP_ROOT, "files"));
loadDotenv({ path: path.join(APP_ROOT, ".env") });

function newRowId() {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function mapLlmToRagItems(llmItems) {
  return llmItems
    .filter((r) => String(r.question || "").trim())
    .map((r) => ({
      id: newRowId(),
      question: String(r.question).trim(),
      recalled: "",
      last_top_id: r.answers?.[0]?.id || r.candidates?.[0]?.id || r.last_top_id || undefined,
    }));
}

async function copyViaPg(llmKbId, ragKbId, items) {
  const { loadSettings } = await import("../src/config.js");
  const { replaceRecallTests } = await import("../src/db/repositories/recallTestsRepo.js");
  const settings = loadSettings();
  if (!settings.databaseUrl) return false;
  process.env.DATABASE_URL = settings.databaseUrl;
  await replaceRecallTests("rag", ragKbId, { items });
  return true;
}

async function main() {
  const llmKbId = process.argv[2] || "1";
  const ragKbId = process.argv[3] || llmKbId;
  const llmPath = path.join(FILES_ROOT, `kb_${llmKbId}`, "recall_tests.json");
  if (!fs.existsSync(llmPath)) {
    console.error(`未找到: ${llmPath}`);
    process.exit(1);
  }
  const llmDoc = JSON.parse(fs.readFileSync(llmPath, "utf8"));
  const items = mapLlmToRagItems(llmDoc.items || []);
  if (!items.length) {
    console.error("LLM 召回测试无有效问题");
    process.exit(1);
  }

  const ragDir = path.join(FILES_ROOT, `rag_kb_${ragKbId}`);
  fs.mkdirSync(ragDir, { recursive: true });
  const ragPath = path.join(ragDir, "recall_tests.json");
  fs.writeFileSync(ragPath, JSON.stringify({ items }, null, 2), "utf8");
  console.log(`[copy-recall] 已写入 ${path.relative(FILES_ROOT, ragPath)}（${items.length} 条）`);

  try {
    const pgOk = await copyViaPg(llmKbId, ragKbId, items);
    if (pgOk) console.log(`[copy-recall] 已同步到 PostgreSQL rag_kb_${ragKbId}`);
  } catch (e) {
    console.warn(`[copy-recall] PostgreSQL 同步跳过: ${(e).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
