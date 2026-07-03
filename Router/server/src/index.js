import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT } from "./config.js";
import { verifyConnection } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { ensureJsonSeeded } from "./db/ensureJsonSeeded.js";
import { createApp, createAppContext } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(APP_ROOT, "client", "dist");

async function main() {
    const settings = (await import("./config.js")).loadSettings();
    if (!settings.databaseUrl)
        throw new Error("DATABASE_URL 未配置，请在 Router/.env 中设置");
    process.env.DATABASE_URL = settings.databaseUrl;

    await runMigrations();
    const ok = await verifyConnection();
    if (!ok)
        throw new Error("无法连接 PostgreSQL，请检查 DATABASE_URL");
    console.log("[db] PostgreSQL 连接成功");

    await ensureJsonSeeded(settings);
    const ctx = await createAppContext();
    const app = createApp(ctx, clientDist);
    const port = Number(process.env.PORT ?? 8002);
    const host = process.env.HOST ?? "0.0.0.0";
    app.listen(port, host, () => {
        console.log(`knowledge_router server listening on http://${host}:${port}`);
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
