#!/usr/bin/env node
/**
 * 创建 router 数据库并写入 Router/.env 的 DATABASE_URL
 * 用法：PGPASSWORD=你的密码 npm run db:setup -w server
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(APP_ROOT, ".env");

const user = process.env.PGUSER || "postgres";
const password = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "";
const host = process.env.PGHOST || "127.0.0.1";
const port = Number(process.env.PGPORT || 5432);
const dbName = process.env.PGDATABASE || "router";

async function main() {
    const adminUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/postgres`;
    const pool = new pg.Pool({ connectionString: adminUrl });
    try {
        const exists = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
        if (!exists.rows.length) {
            await pool.query(`CREATE DATABASE ${dbName}`);
            console.log(`[setup] 已创建数据库: ${dbName}`);
        }
        else {
            console.log(`[setup] 数据库已存在: ${dbName}`);
        }
    }
    finally {
        await pool.end();
    }

    const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`;
    let envText = "";
    if (fs.existsSync(ENV_PATH))
        envText = fs.readFileSync(ENV_PATH, "utf-8");
    else if (fs.existsSync(path.join(APP_ROOT, ".env.example")))
        envText = fs.readFileSync(path.join(APP_ROOT, ".env.example"), "utf-8");

    if (/^DATABASE_URL=/m.test(envText)) {
        envText = envText.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${databaseUrl}`);
    }
    else {
        envText = `${envText.trim()}\nDATABASE_URL=${databaseUrl}\nDATABASE_POOL_SIZE=20\n`.trim() + "\n";
    }
    fs.writeFileSync(ENV_PATH, envText, "utf-8");
    console.log(`[setup] 已写入 ${ENV_PATH}`);
    console.log(`[setup] DATABASE_URL=${databaseUrl.replace(password, password ? "****" : "")}`);
}

main().catch((err) => {
    console.error("[setup] 失败:", err.message);
    console.error("请设置 PGPASSWORD 环境变量后重试，例如：");
    console.error('  $env:PGPASSWORD="你的密码"; npm run db:setup -w server');
    process.exit(1);
});
