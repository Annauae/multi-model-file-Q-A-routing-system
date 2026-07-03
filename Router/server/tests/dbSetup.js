import { runMigrations } from "../src/db/migrate.js";
import { query, closePool } from "../src/db/pool.js";
import fs from "node:fs";
import path from "node:path";
import * as kbRepo from "../src/db/repositories/kbRepo.js";
import * as qaRepo from "../src/db/repositories/qaRepo.js";
import * as settingsRepo from "../src/db/repositories/settingsRepo.js";
import { ModelsStore } from "../src/db/stores/modelsStore.js";
import { MatchProfilesStore } from "../src/db/stores/matchProfilesStore.js";
import { loadSettings } from "../src/config.js";

export async function resetTestDb() {
    await query(`
        TRUNCATE TABLE
            operation_logs, recall_tests, qa_items, qa_documents,
            rag_eval_runs, rag_index_meta, rag_runtime_configs,
            llm_knowledge_bases, rag_knowledge_bases, app_settings,
            data_migrations
        RESTART IDENTITY CASCADE
    `);
}

export async function seedTestKb(settings) {
    const now = "2026-06-23T00:00:00Z";
    await kbRepo.createLlmKb("1", "测试");
    await qaRepo.replaceAll("llm", "1", 1, [{
        id: "q001",
        question: "曝光补偿怎么用？",
        variants: [],
        answer: "预存回答内容",
        enabled: true,
        updated_at: now,
    }]);

    await kbRepo.createRagKb("1", "RAG 测试");
    await qaRepo.replaceAll("rag", "1", 1, [{
        id: "q001",
        question: "RAG 曝光补偿",
        variants: ["怎么调曝光"],
        answer: "RAG 预存回答",
        enabled: true,
        updated_at: now,
    }]);

    const filesRoot = settings.filesRoot;
    const ragAssets = path.join(filesRoot, "rag_kb_1", "assets");
    fs.mkdirSync(ragAssets, { recursive: true });
    fs.mkdirSync(path.join(filesRoot, "kb_1", "assets"), { recursive: true });

    const modelsStore = ModelsStore.fromSettings(settings);
    await modelsStore.init();
    const matchProfilesStore = MatchProfilesStore.open(modelsStore);
    await matchProfilesStore.init();
    await settingsRepo.setSetting("prompts", {
        confidence_match_prompt: "test",
        faq_generation_prompt: "test",
        pdf_vlm_prompt: "test",
        updated_at: now,
    });
}

export async function setupTestDatabase() {
    process.env.MOCK_LLM = process.env.MOCK_LLM ?? "1";
    process.env.MOCK_WEAVIATE = process.env.MOCK_WEAVIATE ?? "1";
    process.env.API_KEY = process.env.API_KEY ?? "test";
    const settings = loadSettings();
    const testUrl = (process.env.TEST_DATABASE_URL ?? "").trim() || settings.databaseUrl;
    if (!testUrl)
        throw new Error("TEST_DATABASE_URL 或 DATABASE_URL 未配置");
    process.env.DATABASE_URL = testUrl;
    await runMigrations();
    await resetTestDb();
    await seedTestKb(settings);
    return settings;
}

export async function teardownTestDatabase() {
    await closePool();
}
