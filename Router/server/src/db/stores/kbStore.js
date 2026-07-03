import fs from "node:fs";
import * as kbRepo from "../repositories/kbRepo.js";
import { kbDirPath } from "../../services/paths.js";

export class KbStore {
    cache = null;

    async init() {
        this.cache = await kbRepo.getAllLlmKbs();
    }

    _ensureCache() {
        if (!this.cache)
            throw new Error("KbStore 未初始化，请先 await init()");
    }

    getAll() {
        this._ensureCache();
        const out = {};
        for (const [k, v] of Object.entries(this.cache)) {
            if (v && typeof v === "object")
                out[k] = { ...v };
        }
        return out;
    }

    get(kbId) {
        this._ensureCache();
        const cfg = this.cache[kbId];
        return cfg && typeof cfg === "object" ? { ...cfg } : null;
    }

    async nextAvailableKbId() {
        return kbRepo.nextAvailableLlmKbId();
    }

    async createKb(kbId, name) {
        const cfg = await kbRepo.createLlmKb(kbId, name);
        this._ensureCache();
        this.cache[kbId] = { ...cfg };
        return { ...cfg };
    }

    async deleteKb(kbId) {
        const cfg = await kbRepo.deleteLlmKb(kbId);
        this._ensureCache();
        delete this.cache[kbId];
        return { ...cfg };
    }

    async renameKb(kbId, name) {
        const cfg = await kbRepo.renameLlmKb(kbId, name);
        this._ensureCache();
        this.cache[kbId] = { ...cfg };
        return { ...cfg };
    }

    deleteKbFiles(kbId, filesRoot) {
        const target = kbDirPath(filesRoot, kbId);
        if (fs.existsSync(target))
            fs.rmSync(target, { recursive: true, force: true });
    }

    async refresh() {
        await this.init();
    }
}
