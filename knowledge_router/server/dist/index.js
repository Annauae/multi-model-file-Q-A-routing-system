import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT } from "./config.js";
import { createApp, createAppContext } from "./app.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(APP_ROOT, "client", "dist");
const ctx = createAppContext();
const app = createApp(ctx, clientDist);
const port = Number(process.env.PORT ?? 8001);
const host = process.env.HOST ?? "0.0.0.0";
app.listen(port, host, () => {
    console.log(`knowledge_router server listening on http://${host}:${port}`);
});
