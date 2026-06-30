import fs from "node:fs";
import path from "node:path";
function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
export class PromptsStore {
    filePath;
    onChange;
    data = {
        confidence_match_prompt: "",
        faq_generation_prompt: "",
        pdf_vlm_prompt: "",
        updated_at: "",
    };
    constructor(filePath, onChange) {
        this.filePath = filePath;
        this.onChange = onChange;
        this.loadOrSeed();
    }
    static open(filePath, onChange) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        return new PromptsStore(filePath, onChange);
    }
    loadOrSeed() {
        if (!fs.existsSync(this.filePath)) {
            this.data = {
                confidence_match_prompt: "",
                faq_generation_prompt: "",
                pdf_vlm_prompt: "",
                updated_at: nowIso(),
            };
            this.save();
            return;
        }
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        this.data = {
            confidence_match_prompt: String(raw.confidence_match_prompt ?? ""),
            faq_generation_prompt: String(raw.faq_generation_prompt ?? ""),
            pdf_vlm_prompt: String(raw.pdf_vlm_prompt ?? ""),
            updated_at: String(raw.updated_at ?? ""),
        };
    }
    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    }
    get() {
        return { ...this.data };
    }
    set(patch) {
        if (patch.confidence_match_prompt != null) {
            this.data.confidence_match_prompt = patch.confidence_match_prompt || "";
        }
        if (patch.faq_generation_prompt != null) {
            this.data.faq_generation_prompt = patch.faq_generation_prompt || "";
        }
        if (patch.pdf_vlm_prompt != null) {
            this.data.pdf_vlm_prompt = patch.pdf_vlm_prompt || "";
        }
        this.data.updated_at = nowIso();
        this.save();
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
