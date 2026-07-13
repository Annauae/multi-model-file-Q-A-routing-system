#!/usr/bin/env node
/**
 * 将知识库 FAQ 答案整合为一个 Markdown 文件，写入 files/documents/modules/
 * 图片复制到 files/documents/assets/，路径统一为 assets/ 前缀（modules 预览可用）
 * 用法: node scripts/export-faq-answers.mjs [kbId]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../..");
const FILES_ROOT = path.resolve(process.env.FILES_ROOT || path.join(APP_ROOT, "files"));
const MODULES_DIR = path.join(FILES_ROOT, "documents", "modules");
const DOCUMENTS_ASSETS_DIR = path.join(FILES_ROOT, "documents", "assets");

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_IMG_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

function parseQuestionNum(id) {
  const m = String(id || "").match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function normalizeAssetRef(ref) {
  let r = String(ref || "").trim().replace(/\\/g, "/");
  if (!r || r.startsWith("http://") || r.startsWith("https://") || r.startsWith("/preview-asset")) return r;
  if (r.startsWith("/assets/")) r = r.slice(1);
  if (r.startsWith("./assets/")) r = r.slice(2);
  if (r.startsWith("../")) return r;
  if (!r.startsWith("assets/")) r = `assets/${path.posix.basename(r)}`;
  return r;
}

function collectAssetRefs(text) {
  const refs = new Set();
  const src = text || "";
  for (const m of src.matchAll(MD_IMAGE_RE)) {
    const n = normalizeAssetRef(m[2]);
    if (n && !n.startsWith("http")) refs.add(n);
  }
  for (const m of src.matchAll(HTML_IMG_RE)) {
    const n = normalizeAssetRef(m[1]);
    if (n && !n.startsWith("http")) refs.add(n);
  }
  return refs;
}

function rewriteAssetPaths(text) {
  let out = text || "";
  out = out.replace(MD_IMAGE_RE, (full, alt, ref) => {
    const n = normalizeAssetRef(ref);
    if (n.startsWith("http")) return full;
    return `![${alt}](${n})`;
  });
  out = out.replace(HTML_IMG_RE, (tag, ref) => {
    const n = normalizeAssetRef(ref);
    if (n.startsWith("http")) return tag;
    return tag.replace(ref, n);
  });
  return out;
}

function copyKbAssetsToDocuments(kbId, refs) {
  const kbAssetsDir = path.join(FILES_ROOT, `kb_${kbId}`, "assets");
  const ragAssetsDir = path.join(FILES_ROOT, `rag_kb_${kbId}`, "assets");
  fs.mkdirSync(DOCUMENTS_ASSETS_DIR, { recursive: true });
  let copied = 0;
  let missing = 0;
  for (const ref of refs) {
    const fileName = ref.startsWith("assets/") ? ref.slice("assets/".length) : path.posix.basename(ref);
    const dest = path.join(DOCUMENTS_ASSETS_DIR, fileName);
    if (fs.existsSync(dest)) {
      copied += 1;
      continue;
    }
    const sources = [
      path.join(kbAssetsDir, fileName),
      path.join(ragAssetsDir, fileName),
    ];
    const src = sources.find((p) => fs.existsSync(p));
    if (!src) {
      missing += 1;
      continue;
    }
    fs.copyFileSync(src, dest);
    copied += 1;
  }
  return { copied, missing };
}

function buildMergedMarkdown(kbId, items) {
  const sorted = [...items].sort((a, b) => parseQuestionNum(a.id) - parseQuestionNum(b.id));
  const allRefs = new Set();
  for (const it of sorted) {
    for (const ref of collectAssetRefs(it.answer || "")) allRefs.add(ref);
  }
  const { copied, missing } = copyKbAssetsToDocuments(kbId, allRefs);
  const lines = [
    `# FAQ 答案合集（kb_${kbId}）`,
    "",
    `> 自动生成，共 ${sorted.length} 条。图片路径为 \`assets/\` 前缀，可在文件管理 modules 预览中正常显示（已同步 ${copied} 张图片到 documents/assets/）。`,
    "",
  ];
  if (missing > 0) {
    lines.push(`> 注意：有 ${missing} 张图片在 kb_${kbId}/assets 中未找到，预览时将尝试从知识库 assets 回退加载。`, "");
  }
  for (const it of sorted) {
    lines.push("---", "");
    lines.push(`## ${it.id} · ${(it.question || "").replace(/\n/g, " ")}`, "");
    if (it.enabled === false) lines.push("*（已禁用）*", "");
    lines.push(rewriteAssetPaths(it.answer || ""), "");
  }
  return { md: lines.join("\n"), imageCount: allRefs.size, copied, missing };
}

async function loadItemsFromPg(kbId) {
  const { config: loadDotenv } = await import("dotenv");
  const { loadSettings } = await import("../src/config.js");
  const { getDocument } = await import("../src/db/repositories/qaRepo.js");
  loadDotenv({ path: path.join(APP_ROOT, ".env") });
  const settings = loadSettings();
  if (!settings.databaseUrl) {
    console.error("DATABASE_URL 未配置，无法从 PostgreSQL 读取 FAQ");
    process.exit(1);
  }
  process.env.DATABASE_URL = settings.databaseUrl;
  const doc = await getDocument("llm", kbId);
  return doc?.items ?? [];
}

async function main() {
  const kbId = process.argv[2] || "1";
  const items = await loadItemsFromPg(kbId);
  if (!items.length) {
    console.error(`kb_${kbId} 在 PostgreSQL 中无 FAQ 条目`);
    process.exit(1);
  }
  fs.mkdirSync(MODULES_DIR, { recursive: true });
  const outName = `merged_faq_answers_kb${kbId}.md`;
  const outPath = path.join(MODULES_DIR, outName);
  const { md, imageCount, copied, missing } = buildMergedMarkdown(kbId, items);
  fs.writeFileSync(outPath, md, "utf8");
  const rel = path.relative(FILES_ROOT, outPath).replace(/\\/g, "/");
  console.log(`[export-faq] 已写入 ${rel}（${items.length} 条，${imageCount} 处图片引用，复制 ${copied} 张，缺失 ${missing} 张）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
