import { v4 as uuidv4 } from "uuid";
import * as settingsRepo from "../repositories/settingsRepo.js";
import { MASK, parseEnableThinking } from "./modelUtils.js";

export const DEFAULT_PROFILE_ID = "default";
const SETTINGS_KEY = "match_profiles";

export class MatchProfilesStore {
    seedFrom;
    profiles = [];
    defaultId = DEFAULT_PROFILE_ID;

    constructor(seedFrom) {
        this.seedFrom = seedFrom;
    }

    static open(modelsStore) {
        const seed = modelsStore?.getSlot("match");
        return new MatchProfilesStore(seed);
    }

    async init() {
        const row = await settingsRepo.getSetting(SETTINGS_KEY);
        if (!row) {
            await this.seedEmpty();
            return;
        }
        const raw = row.value;
        this.defaultId = String(raw.default_id ?? DEFAULT_PROFILE_ID);
        const rows = Array.isArray(raw.profiles) ? raw.profiles : [];
        this.profiles = [];
        for (const r of rows) {
            if (!r || typeof r !== "object")
                continue;
            const pid = String(r.id ?? "").trim();
            if (!pid)
                continue;
            let key = String(r.api_key ?? "").trim();
            if (key === MASK)
                key = "";
            this.profiles.push({
                id: pid,
                name: String(r.name ?? pid).trim() || pid,
                api_base_url: String(r.api_base_url ?? "").trim(),
                api_key: key,
                model: String(r.model ?? "").trim(),
                max_tokens: Number(r.max_tokens ?? 4096),
                temperature: Number(r.temperature ?? 0),
                enable_thinking: parseEnableThinking(r.enable_thinking),
            });
        }
        if (!this.profiles.length)
            await this.seedEmpty();
    }

    async seedEmpty() {
        const cfg = this.seedFrom;
        this.profiles = [{
            id: DEFAULT_PROFILE_ID,
            name: "默认问答模型",
            api_base_url: cfg?.api_base_url ?? "",
            api_key: cfg?.api_key ?? "",
            model: cfg?.model ?? "",
            max_tokens: cfg?.max_tokens ?? 4096,
            temperature: cfg?.temperature ?? 0,
            enable_thinking: cfg?.enable_thinking ?? null,
        }];
        this.defaultId = DEFAULT_PROFILE_ID;
        await this.save();
    }

    async save() {
        await settingsRepo.setSetting(SETTINGS_KEY, {
            default_id: this.defaultId,
            profiles: this.profiles.map((p) => this.toDict(p, false)),
        });
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
        if (!p && this.profiles.length)
            p = this.profiles.find((x) => x.id === this.defaultId) ?? this.profiles[0];
        if (!p)
            throw new Error(`match profile not found: ${profileId}`);
        return { ...p };
    }

    async updateAll(body) {
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
        if (body.default_id && String(body.default_id).trim())
            this.defaultId = String(body.default_id).trim();
        await this.save();
        return {
            default_id: this.defaultId,
            profiles: this.profiles.map((p) => this.toDict(p, false)),
        };
    }
}
