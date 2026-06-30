import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { MASK, parseEnableThinking } from "./modelsStore.js";
export const DEFAULT_PROFILE_ID = "default";
export class MatchProfilesStore {
    filePath;
    seedFrom;
    profiles = [];
    defaultId = DEFAULT_PROFILE_ID;
    constructor(filePath, seedFrom) {
        this.filePath = filePath;
        this.seedFrom = seedFrom;
        this.loadOrSeed();
    }
    static open(filePath, modelsStore) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const seed = modelsStore?.getSlot("match");
        return new MatchProfilesStore(filePath, seed);
    }
    loadOrSeed() {
        if (!fs.existsSync(this.filePath)) {
            const cfg = this.seedFrom;
            this.profiles = [
                {
                    id: DEFAULT_PROFILE_ID,
                    name: "默认回答模型",
                    api_base_url: cfg?.api_base_url ?? "",
                    api_key: cfg?.api_key ?? "",
                    model: cfg?.model ?? "",
                    max_tokens: cfg?.max_tokens ?? 4096,
                    temperature: cfg?.temperature ?? 0,
                    enable_thinking: cfg?.enable_thinking ?? null,
                },
            ];
            this.defaultId = DEFAULT_PROFILE_ID;
            this.save();
            return;
        }
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        this.defaultId = String(raw.default_id ?? DEFAULT_PROFILE_ID);
        const rows = Array.isArray(raw.profiles) ? raw.profiles : [];
        this.profiles = [];
        for (const row of rows) {
            if (!row || typeof row !== "object")
                continue;
            const pid = String(row.id ?? "").trim();
            if (!pid)
                continue;
            let key = String(row.api_key ?? "").trim();
            if (key === MASK)
                key = "";
            this.profiles.push({
                id: pid,
                name: String(row.name ?? pid).trim() || pid,
                api_base_url: String(row.api_base_url ?? "").trim(),
                api_key: key,
                model: String(row.model ?? "").trim(),
                max_tokens: Number(row.max_tokens ?? 4096),
                temperature: Number(row.temperature ?? 0),
                enable_thinking: parseEnableThinking(row.enable_thinking),
            });
        }
        if (!this.profiles.length)
            this.seedEmpty();
    }
    seedEmpty() {
        const cfg = this.seedFrom;
        this.profiles = [
            {
                id: DEFAULT_PROFILE_ID,
                name: "默认回答模型",
                api_base_url: cfg?.api_base_url ?? "",
                api_key: cfg?.api_key ?? "",
                model: cfg?.model ?? "",
                max_tokens: cfg?.max_tokens ?? 4096,
                temperature: cfg?.temperature ?? 0,
                enable_thinking: cfg?.enable_thinking ?? null,
            },
        ];
        this.defaultId = DEFAULT_PROFILE_ID;
        this.save();
    }
    save() {
        fs.writeFileSync(this.filePath, JSON.stringify({
            default_id: this.defaultId,
            profiles: this.profiles.map((p) => this.toDict(p, false)),
        }, null, 2), "utf-8");
    }
    toDict(p, maskKey) {
        const out = {
            id: p.id,
            name: p.name,
            api_base_url: p.api_base_url,
            api_key: maskKey && p.api_key ? MASK : p.api_key,
            model: p.model,
            max_tokens: p.max_tokens,
            temperature: p.temperature,
        };
        if (p.enable_thinking != null)
            out.enable_thinking = p.enable_thinking;
        return out;
    }
    listProfiles(maskKey = true) {
        return this.profiles.map((p) => this.toDict(p, maskKey));
    }
    getDefaultId() {
        return this.defaultId;
    }
    get(profileId = "") {
        const pid = (profileId || "").trim() || this.defaultId;
        let p = this.profiles.find((x) => x.id === pid);
        if (!p && this.profiles.length) {
            p = this.profiles.find((x) => x.id === this.defaultId) ?? this.profiles[0];
        }
        if (!p)
            throw new Error(`match profile not found: ${profileId}`);
        return { ...p };
    }
    updateAll(body) {
        const rows = body.profiles;
        if (Array.isArray(rows)) {
            const updated = [];
            for (const row of rows) {
                if (!row || typeof row !== "object")
                    continue;
                const pid = String(row.id ?? "").trim() || `p_${uuidv4().slice(0, 8)}`;
                const old = this.profiles.find((x) => x.id === pid);
                let newKey = old?.api_key ?? "";
                if (row.api_key != null) {
                    const k = String(row.api_key).trim();
                    if (k !== MASK)
                        newKey = k;
                }
                let enableThinking = old?.enable_thinking ?? null;
                if ("enable_thinking" in row)
                    enableThinking = parseEnableThinking(row.enable_thinking);
                updated.push({
                    id: pid,
                    name: String(row.name ?? pid).trim() || pid,
                    api_base_url: String(row.api_base_url ?? old?.api_base_url ?? "").trim(),
                    api_key: newKey,
                    model: String(row.model ?? old?.model ?? "").trim(),
                    max_tokens: Number(row.max_tokens ?? old?.max_tokens ?? 4096),
                    temperature: Number(row.temperature ?? old?.temperature ?? 0),
                    enable_thinking: enableThinking,
                });
            }
            if (updated.length)
                this.profiles = updated;
        }
        if (body.default_id && String(body.default_id).trim()) {
            this.defaultId = String(body.default_id).trim();
        }
        this.save();
        return {
            default_id: this.defaultId,
            profiles: this.profiles.map((p) => this.toDict(p, false)),
        };
    }
}
