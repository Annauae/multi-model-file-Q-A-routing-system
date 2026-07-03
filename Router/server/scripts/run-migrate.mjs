#!/usr/bin/env node
import { loadSettings } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";

const settings = loadSettings();
if (!settings.databaseUrl)
    throw new Error("DATABASE_URL 未配置，请在 Router/.env 中设置");
process.env.DATABASE_URL = settings.databaseUrl;
await runMigrations();
console.log("[db] 迁移完成");
