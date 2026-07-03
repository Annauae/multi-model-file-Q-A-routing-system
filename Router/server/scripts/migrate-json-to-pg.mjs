#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { runMigrations } from "../src/db/migrate.js";
import { migrateJsonToPg } from "../src/db/ensureJsonSeeded.js";
import { loadSettings } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../..");
loadDotenv({ path: path.join(APP_ROOT, ".env") });

async function main() {
    const settings = loadSettings();
    if (!settings.databaseUrl)
        throw new Error("DATABASE_URL 未配置");
    process.env.DATABASE_URL = settings.databaseUrl;
    await runMigrations();
    await migrateJsonToPg(settings.dataRoot, settings.filesRoot);
    console.log("[db:seed] 完成");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
