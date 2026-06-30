import fs from "node:fs";
import path from "node:path";

function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function emptyDocument() {
    return { version: 1, items: [] };
}

function validateItems(items) {
    const seen = new Set();
    const out = [];
    for (const raw of items) {
        const itemId = String(raw.id ?? "").trim();
        const question = String(raw.question ?? "").trim();
        const answer = String(raw.answer ?? "").trim();
        if (!itemId)
            throw new Error("id 不能为空");
        if (seen.has(itemId))
            throw new Error(`id 重复: ${itemId}`);
        if (!question)
            throw new Error(`question 不能为空: ${itemId}`);
        if (!answer)
            throw new Error(`answer 不能为空: ${itemId}`);
        seen.add(itemId);
        let variants = raw.variants;
        if (!Array.isArray(variants))
            variants = [];
        const normVariants = variants
            .map((v) => String(v).trim())
            .filter(Boolean);
        let enabled = raw.enabled;
        if (typeof enabled !== "boolean")
            enabled = true;
        out.push({
            id: itemId,
            question,
            variants: normVariants,
            answer,
            enabled,
            updated_at: String(raw.updated_at ?? "").trim() || nowIso(),
        });
    }
    return out;
}

export class RagQuestionsStore {
    filePath;
    kbId;
    onChange;
    cache;

    constructor(filePath, kbId, onChange) {
        this.filePath = filePath;
        this.kbId = kbId;
        this.onChange = onChange;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(emptyDocument(), null, 2), "utf-8");
        }
        this.cache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }

    static open(filePath, kbId, onChange) {
        return new RagQuestionsStore(filePath, kbId, onChange);
    }

    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), "utf-8");
        this.onChange?.(this.kbId);
    }

    getDocument() {
        const version = Number(this.cache.version ?? 1) || 1;
        const itemsRaw = Array.isArray(this.cache.items) ? this.cache.items : [];
        const items = itemsRaw
            .filter((x) => x && typeof x === "object")
            .map((x) => ({
            id: String(x.id ?? ""),
            question: String(x.question ?? ""),
            variants: Array.isArray(x.variants) ? x.variants.map(String) : [],
            answer: String(x.answer ?? ""),
            enabled: x.enabled !== false,
            updated_at: String(x.updated_at ?? ""),
        }));
        return { version, items };
    }

    replaceAll(version, items) {
        this.cache = { version: Math.max(1, version), items: validateItems(items) };
        this.save();
        return this.getDocument();
    }

    getItem(itemId) {
        return this.getDocument().items.find((i) => i.id === itemId) ?? null;
    }

    upsertItem(item) {
        const validated = validateItems([item])[0];
        validated.updated_at = nowIso();
        const items = Array.isArray(this.cache.items) ? [...this.cache.items] : [];
        let replaced = false;
        const newItems = [];
        for (const raw of items) {
            if (raw && typeof raw === "object" && String(raw.id ?? "").trim() === validated.id) {
                newItems.push(validated);
                replaced = true;
            }
            else if (raw && typeof raw === "object") {
                newItems.push(raw);
            }
        }
        if (!replaced)
            newItems.push(validated);
        this.cache.items = newItems;
        this.save();
        const result = this.getItem(validated.id);
        if (!result)
            throw new Error("upsert failed");
        return result;
    }

    deleteItem(itemId) {
        const items = Array.isArray(this.cache.items) ? this.cache.items : [];
        let deleted = null;
        const kept = [];
        for (const raw of items) {
            if (raw && typeof raw === "object" && String(raw.id ?? "").trim() === itemId) {
                deleted = raw;
            }
            else if (raw && typeof raw === "object") {
                kept.push(raw);
            }
        }
        if (!deleted)
            throw new Error("item_id 不存在");
        this.cache.items = kept;
        this.save();
        return {
            id: String(deleted.id ?? ""),
            question: String(deleted.question ?? ""),
            variants: Array.isArray(deleted.variants) ? deleted.variants.map(String) : [],
            answer: String(deleted.answer ?? ""),
            enabled: deleted.enabled !== false,
            updated_at: String(deleted.updated_at ?? ""),
        };
    }

    get sourceMtime() {
        try {
            return fs.statSync(this.filePath).mtimeMs;
        }
        catch {
            return 0;
        }
    }
}
