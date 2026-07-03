import * as settingsRepo from "../repositories/settingsRepo.js";
import { nowIso } from "../utils.js";

const SETTINGS_KEY = "prompts";

export class PromptsStore {
    onChange;
    data = {
        confidence_match_prompt: "",
        faq_generation_prompt: "",
        pdf_vlm_prompt: "",
        updated_at: "",
    };

    constructor(onChange) {
        this.onChange = onChange;
    }

    static open(onChange) {
        return new PromptsStore(onChange);
    }

    async init() {
        const row = await settingsRepo.getSetting(SETTINGS_KEY);
        if (!row) {
            this.data = {
                confidence_match_prompt: "",
                faq_generation_prompt: "",
                pdf_vlm_prompt: "",
                updated_at: nowIso(),
            };
            await this.save();
            return;
        }
        const raw = row.value;
        this.data = {
            confidence_match_prompt: String(raw.confidence_match_prompt ?? ""),
            faq_generation_prompt: String(raw.faq_generation_prompt ?? ""),
            pdf_vlm_prompt: String(raw.pdf_vlm_prompt ?? ""),
            updated_at: String(raw.updated_at ?? row.updated_at ?? ""),
        };
    }

    async save() {
        await settingsRepo.setSetting(SETTINGS_KEY, this.data);
    }

    get() {
        return { ...this.data };
    }

    async set(patch) {
        if (patch.confidence_match_prompt != null)
            this.data.confidence_match_prompt = patch.confidence_match_prompt || "";
        if (patch.faq_generation_prompt != null)
            this.data.faq_generation_prompt = patch.faq_generation_prompt || "";
        if (patch.pdf_vlm_prompt != null)
            this.data.pdf_vlm_prompt = patch.pdf_vlm_prompt || "";
        this.data.updated_at = nowIso();
        await this.save();
        const out = { ...this.data };
        this.onChange?.();
        return out;
    }

    effectiveConfidencePrompt() {
        return this.get().confidence_match_prompt.trim();
    }

    effectiveFaqPrompt() {
        return this.get().faq_generation_prompt.trim();
    }

    effectivePdfVlmPrompt() {
        return this.get().pdf_vlm_prompt.trim();
    }
}
