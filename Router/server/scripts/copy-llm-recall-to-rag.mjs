#!/usr/bin/env node
/**
 * 将问答模型（LLM）召回测试问题复制到 RAG 知识库（PostgreSQL）
 * 用法: node scripts/copy-llm-recall-to-rag.mjs [llmKbId] [ragKbId]
 * 默认均为 1
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../..");
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

async function main() {
  const llmKbId = process.argv[2] || "1";
  const ragKbId = process.argv[3] || llmKbId;
  const { loadSettings } = await import("../src/config.js");
  const { getRecallTests, replaceRecallTests } = await import("../src/db/repositories/recallTestsRepo.js");
  const settings = loadSettings();
  if (!settings.databaseUrl) {
    console.error("DATABASE_URL 未配置");
    process.exit(1);
  }
  process.env.DATABASE_URL = settings.databaseUrl;

  const llmDoc = await getRecallTests("llm", llmKbId);
  const items = mapLlmToRagItems(llmDoc?.items ?? []);
  if (!items.length) {
    console.error("LLM 召回测试无有效问题");
    process.exit(1);
  }

  await replaceRecallTests("rag", ragKbId, { items });
  console.log(`[copy-recall] 已写入 PostgreSQL rag_kb_${ragKbId}（${items.length} 条）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
