import * as settingsRepo from "../repositories/settingsRepo.js";
import { MASK, parseEnableThinking } from "./modelUtils.js";

export const RAG_SLOTS = ["embedding", "rerank", "llm", "judge"];
const SETTINGS_KEY = "rag_models";

export class RagModelsStore {
    defaults;
    slots = {};

    constructor(defaults) {
        this.defaults = defaults;
    }

    static fromSettings(settings) {
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
                label: "RAG 问答模型",
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
        return new RagModelsStore(defaults);
    }

    async init() {
        const row = await settingsRepo.getSetting(SETTINGS_KEY);
        if (!row) {
            this.slots = JSON.parse(JSON.stringify(this.defaults));
            await this.save();
            return;
        }
        const raw = row.value;
        this.slots = {};
        for (const slot of RAG_SLOTS) {
            const base = this.defaults[slot];
            const r = raw?.[slot];
            const rowData = r && typeof r === "object" ? r : {};
            let key = String(rowData.api_key ?? "").trim();
            if (key === MASK)
                key = "";
            this.slots[slot] = {
                label: String(rowData.label ?? base.label),
                api_base_url: String(rowData.api_base_url ?? base.api_base_url).trim() || base.api_base_url,
                api_key: key,
                model: String(rowData.model ?? base.model).trim() || base.model,
                max_tokens: Number(rowData.max_tokens ?? base.max_tokens),
                temperature: Number(rowData.temperature ?? base.temperature),
                enable_thinking: parseEnableThinking(rowData.enable_thinking ?? base.enable_thinking),
            };
        }
    }

    async save() {
        const payload = {};
        for (const slot of RAG_SLOTS)
            payload[slot] = this.toDict(this.slots[slot], false);
        await settingsRepo.setSetting(SETTINGS_KEY, payload);
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

    async updateSlot(slot, patch) {
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
        await this.save();
        return this.toDict(this.slots[slot], false);
    }

    async updateAll(body) {
        for (const slot of RAG_SLOTS) {
            if (body[slot] && typeof body[slot] === "object")
                await this.updateSlot(slot, body[slot]);
        }
        return this.getAll(false);
    }
}

export { MASK };
