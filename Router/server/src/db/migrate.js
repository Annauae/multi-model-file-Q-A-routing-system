import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

export async function runMigrations() {
    await query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    if (!fs.existsSync(MIGRATIONS_DIR))
        return;
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
    for (const file of files) {
        const name = file;
        const applied = await query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
        if (applied.rows.length)
            continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
        await query(sql);
        await query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        console.log(`[db] migration applied: ${name}`);
    }
}
