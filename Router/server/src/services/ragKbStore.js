import fs from "node:fs";
import path from "node:path";
import { ragKbDirPath } from "./paths.js";

function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class RagKbStore {
    filePath;
    cache = {};

    constructor(filePath) {
        this.filePath = filePath;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(filePath))
            fs.writeFileSync(filePath, "{}", "utf-8");
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            throw new Error("rag_knowledge_bases.json 结构必须是 JSON object");
        }
        this.cache = data;
    }

    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), "utf-8");
    }

    getAll() {
        const out = {};
        for (const [k, v] of Object.entries(this.cache)) {
            if (v && typeof v === "object")
                out[k] = { ...v };
        }
        return out;
    }

    get(kbId) {
        const cfg = this.cache[kbId];
        return cfg && typeof cfg === "object" ? { ...cfg } : null;
    }

    nextAvailableKbId() {
        const used = new Set();
        for (const kid of Object.keys(this.cache)) {
            if (/^\d+$/.test(kid))
                used.add(parseInt(kid, 10));
        }
        let n = 1;
        while (used.has(n))
            n++;
        return String(n);
    }

    createKb(kbId, name) {
        if (this.cache[kbId])
            throw new Error("kb_id 已存在");
        const now = nowIso();
        const cfg = {
            name,
            status: "ready",
            created_at: now,
            updated_at: now,
        };
        this.cache[kbId] = cfg;
        this.save();
        return { ...cfg };
    }

    deleteKb(kbId) {
        const cfg = this.cache[kbId];
        if (!cfg || typeof cfg !== "object")
            throw new Error("kb_id 不存在");
        delete this.cache[kbId];
        this.save();
        return { ...cfg };
    }

    renameKb(kbId, name) {
        const newName = (name || "").trim();
        if (!newName)
            throw new Error("name 不能为空");
        const cfg = this.cache[kbId];
        if (!cfg || typeof cfg !== "object")
            throw new Error("kb_id 不存在");
        cfg.name = newName;
        cfg.updated_at = nowIso();
        this.save();
        return { ...cfg };
    }

    deleteKbFiles(kbId, filesRoot) {
        const target = ragKbDirPath(filesRoot, kbId);
        if (fs.existsSync(target))
            fs.rmSync(target, { recursive: true, force: true });
    }
}
