import fs from "node:fs";
import path from "node:path";
import { parseEnableThinking } from "./modelsStore.js";

export const RAG_SLOTS = ["embedding", "rerank", "llm", "judge"];
export const MASK = "***";

export class RagModelsStore {
    filePath;
    defaults;
    slots = {};

    constructor(filePath, defaults) {
        this.filePath = filePath;
        this.defaults = defaults;
        this.loadOrSeed();
    }

    static fromSettings(settings) {
        const filePath = path.join(settings.dataRoot, "config", "rag_models.json");
        const baseUrl = settings.siliconflowBaseUrl;
        const apiKey = settings.apiKey;
        const defaults = {
            embedding: {
                label: "Embedding 模型",
                api_base_url: baseUrl,
                api_key: apiKey,
                model: settings.ragEmbeddingModel,
                max_tokens: 0,
                temperature: 0,
            },
            rerank: {
                label: "Rerank 模型",
                api_base_url: baseUrl,
                api_key: apiKey,
                model: settings.ragRerankModel,
                max_tokens: 0,
                temperature: 0,
            },
            llm: {
                label: "RAG 回答模型",
                api_base_url: baseUrl,
                api_key: apiKey,
                model: settings.ragLlmModel,
                max_tokens: 1200,
                temperature: 0.1,
            },
            judge: {
                label: "评测裁判模型",
                api_base_url: baseUrl,
                api_key: apiKey,
                model: settings.ragJudgeModel,
                max_tokens: 500,
                temperature: 0,
            },
        };
        return new RagModelsStore(filePath, defaults);
    }

    loadOrSeed() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(this.filePath)) {
            this.slots = JSON.parse(JSON.stringify(this.defaults));
            this.save();
            return;
        }
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        this.slots = {};
        for (const slot of RAG_SLOTS) {
            const base = this.defaults[slot];
            const row = raw?.[slot];
            const r = row && typeof row === "object" ? row : {};
            let key = String(r.api_key ?? "").trim();
            if (key === MASK)
                key = "";
            this.slots[slot] = {
                label: String(r.label ?? base.label),
                api_base_url: String(r.api_base_url ?? base.api_base_url).trim() || base.api_base_url,
                api_key: key,
                model: String(r.model ?? base.model).trim() || base.model,
                max_tokens: Number(r.max_tokens ?? base.max_tokens),
                temperature: Number(r.temperature ?? base.temperature),
                enable_thinking: parseEnableThinking(r.enable_thinking ?? base.enable_thinking),
            };
        }
    }

    save() {
        const payload = {};
        for (const slot of RAG_SLOTS) {
            payload[slot] = this.toDict(this.slots[slot], false);
        }
        fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
    }

    toDict(cfg, maskKey) {
        const out = {
            label: cfg.label,
            api_base_url: cfg.api_base_url,
            api_key: maskKey && cfg.api_key ? MASK : cfg.api_key,
            model: cfg.model,
            max_tokens: cfg.max_tokens,
            temperature: cfg.temperature,
        };
        if (cfg.enable_thinking != null)
            out.enable_thinking = cfg.enable_thinking;
        return out;
    }

    getSlot(slot) {
        if (!RAG_SLOTS.includes(slot))
            throw new Error(`unknown slot: ${slot}`);
        return { ...this.slots[slot] };
    }

    getAll(maskKey = true) {
        const out = {};
        for (const slot of RAG_SLOTS)
            out[slot] = this.toDict(this.slots[slot], maskKey);
        return out;
    }

    updateSlot(slot, patch) {
        if (!RAG_SLOTS.includes(slot))
            throw new Error(`unknown slot: ${slot}`);
        const cfg = this.slots[slot];
        let newKey = cfg.api_key;
        if (patch.api_key != null) {
            const k = String(patch.api_key).trim();
            if (k !== MASK)
                newKey = k;
        }
        let enableThinking = cfg.enable_thinking;
        if ("enable_thinking" in patch)
            enableThinking = parseEnableThinking(patch.enable_thinking);
        this.slots[slot] = {
            label: String(patch.label ?? cfg.label),
            api_base_url: String(patch.api_base_url ?? cfg.api_base_url).trim() || cfg.api_base_url,
            api_key: newKey,
            model: String(patch.model ?? cfg.model).trim() || cfg.model,
            max_tokens: Number(patch.max_tokens ?? cfg.max_tokens),
            temperature: Number(patch.temperature ?? cfg.temperature),
            enable_thinking: enableThinking,
        };
        this.save();
        return this.toDict(this.slots[slot], false);
    }

    updateAll(body) {
        for (const slot of RAG_SLOTS) {
            if (body[slot] && typeof body[slot] === "object") {
                this.updateSlot(slot, body[slot]);
            }
        }
        return this.getAll(false);
    }
}
