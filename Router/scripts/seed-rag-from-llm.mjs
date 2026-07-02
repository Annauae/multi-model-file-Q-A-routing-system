#!/usr/bin/env node
/** 一次性：从 LLM FAQ 导入到 RAG 并重建索引 */
import { createAppContext } from "../server/src/app.js";
import { importLlmFaqToRag } from "../server/src/services/ragImport.js";
import { rebuildIndex } from "../server/src/services/rag/indexer.js";

const llmKbId = process.argv[2] || "1";
const ragKbId = process.argv[3] || "1";

const ctx = createAppContext();
if (!ctx.ragCtx.ragKbStore.get(ragKbId)) {
  ctx.ragCtx.ragKbStore.createKb(ragKbId, `RAG 知识库 ${ragKbId}`);
}

const result = importLlmFaqToRag(ctx, ragKbId, llmKbId, { append: false, replace: true });
console.log(`[seed-rag] imported ${result.imported} items from llm kb_${llmKbId} -> rag_kb_${ragKbId}`);

const meta = await rebuildIndex(ragKbId, ctx.ragCtx);
console.log(`[seed-rag] index rebuilt: ${meta.search_docs} search docs (question/variant only)`);
