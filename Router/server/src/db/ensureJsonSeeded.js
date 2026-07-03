import fs from "node:fs";
import path from "node:path";
import { query } from "./pool.js";
import * as kbRepo from "./repositories/kbRepo.js";
import * as qaRepo from "./repositories/qaRepo.js";
import * as settingsRepo from "./repositories/settingsRepo.js";
import * as opRepo from "./repositories/operationLogsRepo.js";
import * as recallRepo from "./repositories/recallTestsRepo.js";
import * as ragMetaRepo from "./repositories/ragMetaRepo.js";
import { nowIso } from "./utils.js";

function readJson(filePath, fallback = null) {
    if (!fs.existsSync(filePath))
        return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        return fallback;
    }
}

async function importKnowledgeBases(dataRoot) {
    const llmPath = path.join(dataRoot, "config", "knowledge_bases.json");
    const llm = readJson(llmPath, {});
    for (const [kbId, cfg] of Object.entries(llm || {})) {
        if (!cfg || typeof cfg !== "object")
            continue;
        await query(
            `INSERT INTO llm_knowledge_bases (kb_id, name, match_prompt, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)
             ON CONFLICT (kb_id) DO UPDATE SET
               name = EXCLUDED.name, match_prompt = EXCLUDED.match_prompt,
               status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
            [kbId, cfg.name ?? "", cfg.match_prompt ?? "", cfg.status ?? "ready", cfg.created_at ?? nowIso(), cfg.updated_at ?? nowIso()],
        );
        await qaRepo.ensureQaDocument("llm", kbId);
    }

    const ragPath = path.join(dataRoot, "config", "rag_knowledge_bases.json");
    const rag = readJson(ragPath, {});
    for (const [kbId, cfg] of Object.entries(rag || {})) {
        if (!cfg || typeof cfg !== "object")
            continue;
        await query(
            `INSERT INTO rag_knowledge_bases (kb_id, name, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
             ON CONFLICT (kb_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
            [kbId, cfg.name ?? "", cfg.status ?? "ready", cfg.created_at ?? nowIso(), cfg.updated_at ?? nowIso()],
        );
        await qaRepo.ensureQaDocument("rag", kbId);
    }
}

async function importQuestions(filesRoot) {
    if (!fs.existsSync(filesRoot))
        return;
    for (const entry of fs.readdirSync(filesRoot)) {
        let kbType = null;
        let kbId = null;
        const llmMatch = /^kb_(\d+)$/.exec(entry);
        const ragMatch = /^rag_kb_(\d+)$/.exec(entry);
        if (llmMatch) {
            kbType = "llm";
            kbId = llmMatch[1];
        }
        else if (ragMatch) {
            kbType = "rag";
            kbId = ragMatch[1];
        }
        else {
            continue;
        }
        const qPath = path.join(filesRoot, entry, "questions.json");
        const doc = readJson(qPath);
        if (!doc || !Array.isArray(doc.items))
            continue;
        await qaRepo.replaceAll(kbType, kbId, Number(doc.version ?? 1), doc.items);
    }
}

async function importSettings(dataRoot) {
    const map = {
        models: "models.json",
        rag_models: "rag_models.json",
        prompts: "prompts.json",
        rag_prompts: "rag_prompts.json",
        match_profiles: "match_profiles.json",
    };
    for (const [key, file] of Object.entries(map)) {
        const p = path.join(dataRoot, "config", file);
        const val = readJson(p);
        if (val != null)
            await settingsRepo.setSetting(key, val);
    }
}

async function importLogs(dataRoot) {
    const logPath = path.join(dataRoot, "logs", "operations.jsonl");
    if (!fs.existsSync(logPath))
        return;
    const raw = fs.readFileSync(logPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            const entry = JSON.parse(t);
            if (!entry || typeof entry !== "object")
                continue;
            await query(
                `INSERT INTO operation_logs (ts, level, module, action, kb_id, detail, kind, extra)
                 VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
                [
                    entry.ts ?? nowIso(),
                    entry.level ?? "info",
                    entry.module ?? "system",
                    entry.action ?? "",
                    entry.kb_id ?? "",
                    entry.detail ?? "",
                    entry.kind ?? "log",
                    entry.extra ? JSON.stringify(entry.extra) : null,
                ],
            );
        }
        catch {
            /* skip bad line */
        }
    }
}

async function importRecallTests(filesRoot) {
    if (!fs.existsSync(filesRoot))
        return;
    for (const entry of fs.readdirSync(filesRoot)) {
        let kbType = null;
        let kbId = null;
        const llmMatch = /^kb_(\d+)$/.exec(entry);
        const ragMatch = /^rag_kb_(\d+)$/.exec(entry);
        if (llmMatch) {
            kbType = "llm";
            kbId = llmMatch[1];
        }
        else if (ragMatch) {
            kbType = "rag";
            kbId = ragMatch[1];
        }
        else {
            continue;
        }
        const p = path.join(filesRoot, entry, "recall_tests.json");
        const doc = readJson(p);
        if (!doc)
            continue;
        await recallRepo.replaceRecallTests(kbType, kbId, doc);
    }
}

async function importRagMeta(filesRoot) {
    if (!fs.existsSync(filesRoot))
        return;
    for (const entry of fs.readdirSync(filesRoot)) {
        const m = /^rag_kb_(\d+)$/.exec(entry);
        if (!m)
            continue;
        const kbId = m[1];
        const base = path.join(filesRoot, entry);
        const runtime = readJson(path.join(base, "runtime_config.json"));
        if (runtime)
            await ragMetaRepo.saveRuntimeConfig(kbId, runtime);
        const meta = readJson(path.join(base, "index_meta.json"));
        if (meta)
            await ragMetaRepo.saveIndexMeta(kbId, meta);
        const evalDir = path.join(base, "eval");
        if (fs.existsSync(evalDir)) {
            for (const f of fs.readdirSync(evalDir)) {
                if (!f.endsWith(".json"))
                    continue;
                const data = readJson(path.join(evalDir, f));
                if (data?.run_id)
                    await ragMetaRepo.saveEvalRun(kbId, data.run_id, data);
            }
        }
    }
}

export async function migrateJsonToPg(dataRoot, filesRoot) {
    console.log("[db] 开始导入 JSON 数据…");
    await importKnowledgeBases(dataRoot);
    await importQuestions(filesRoot);
    await importSettings(dataRoot);
    await importLogs(dataRoot);
    await importRecallTests(filesRoot);
    await importRagMeta(filesRoot);
    console.log("[db] JSON 数据导入完成");
}

export async function ensureJsonSeeded(settings) {
    if (["1", "true", "yes"].includes((process.env.SKIP_JSON_SEED ?? "").trim().toLowerCase())) {
        console.log("[db] 跳过 JSON 导入（SKIP_JSON_SEED=1）");
        return;
    }
    if (await ragMetaRepo.hasDataMigration("json_seed_v1")) {
        console.log("[db] 跳过 JSON 导入（已完成 json_seed_v1）");
        return;
    }
    const llmCount = await kbRepo.countLlmKbs();
    const settingsCount = await kbRepo.countAppSettings();
    if (llmCount > 0 || settingsCount > 0) {
        console.log("[db] 跳过 JSON 导入（数据库已有数据）");
        await ragMetaRepo.markDataMigration("json_seed_v1");
        return;
    }
    const hasJson = fs.existsSync(path.join(settings.dataRoot, "config", "knowledge_bases.json"))
        || fs.existsSync(path.join(settings.dataRoot, "config", "models.json"));
    if (!hasJson) {
        console.log("[db] 跳过 JSON 导入（无本地 JSON 源文件）");
        await ragMetaRepo.markDataMigration("json_seed_v1");
        return;
    }
    await migrateJsonToPg(settings.dataRoot, settings.filesRoot);
    await ragMetaRepo.markDataMigration("json_seed_v1");
    console.log("[db] JSON 数据已自动导入（首次启动）");
}
