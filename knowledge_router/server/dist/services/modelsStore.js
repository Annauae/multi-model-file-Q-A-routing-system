import fs from "node:fs";
import path from "node:path";
export const SLOTS = ["match", "import", "pdf_vlm"];
export const MASK = "***";
export function parseEnableThinking(val) {
    if (val == null)
        return null;
    if (typeof val === "boolean")
        return val;
    if (typeof val === "number")
        return Boolean(val);
    if (typeof val === "string") {
        const s = val.trim().toLowerCase();
        if (["1", "true", "yes"].includes(s))
            return true;
        if (["0", "false", "no"].includes(s))
            return false;
    }
    return null;
}
export class ModelsStore {
    filePath;
    defaults;
    slots = {};
    constructor(filePath, defaults) {
        this.filePath = filePath;
        this.defaults = defaults;
        this.loadOrSeed();
    }
    static fromSettings(settings) {
        const filePath = path.join(settings.dataRoot, "config", "models.json");
        const defaults = {
            match: {
                label: "回答模型",
                api_base_url: settings.apiBaseUrl,
                api_key: settings.apiKey,
                model: settings.matchModel,
                max_tokens: settings.confidenceMaxTokens,
                temperature: settings.matchTemperature,
            },
            import: {
                label: "FAQ 生成模型",
                api_base_url: settings.apiBaseUrl,
                api_key: settings.apiKey,
                model: settings.importModel,
                max_tokens: settings.maxTokens,
                temperature: 0.2,
            },
            pdf_vlm: {
                label: "文档提取模型",
                api_base_url: settings.apiBaseUrl,
                api_key: settings.apiKey,
                model: settings.importModel,
                max_tokens: settings.maxTokens,
                temperature: 0,
            },
        };
        return new ModelsStore(filePath, defaults);
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
        for (const slot of SLOTS) {
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
        for (const slot of SLOTS) {
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
        if (!SLOTS.includes(slot))
            throw new Error(`unknown slot: ${slot}`);
        return { ...this.slots[slot] };
    }
    getAll(maskKey = true) {
        const out = {};
        for (const slot of SLOTS)
            out[slot] = this.toDict(this.slots[slot], maskKey);
        return out;
    }
    updateSlot(slot, patch) {
        if (!SLOTS.includes(slot))
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
        for (const slot of SLOTS) {
            if (body[slot] && typeof body[slot] === "object") {
                this.updateSlot(slot, body[slot]);
            }
        }
        return this.getAll(false);
    }
}
