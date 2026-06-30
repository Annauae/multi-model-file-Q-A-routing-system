import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TEMPLATES = [
    {
        id: "default",
        name: "默认严谨模板",
        content: "你是相机 FAQ 助手。请只根据给定 FAQ 来源回答，不能编造；"
            + "如果资料不足，请说明未找到高置信答案。回答使用简体中文。\n\n"
            + "用户问题：{query}\n\nFAQ 来源：\n{context}",
    },
    {
        id: "concise",
        name: "简洁模板",
        content: "请根据以下 FAQ 来源简洁回答用户问题，只输出结论和关键步骤，使用简体中文。\n\n"
            + "用户问题：{query}\n\nFAQ 来源：\n{context}",
    },
    {
        id: "explain",
        name: "详细讲解模板",
        content: "你是耐心的相机使用顾问。请根据 FAQ 来源详细讲解用户问题，"
            + "可补充操作步骤和注意事项，但不要编造资料外的信息。使用简体中文。\n\n"
            + "用户问题：{query}\n\nFAQ 来源：\n{context}",
    },
];

export function defaultRuntimeConfig() {
    return {
        temperature: 0.1,
        top_k: 8,
        top_n: 3,
        answer_mode: "direct",
        use_rerank: true,
        min_confidence_score: 0.05,
        active_template_id: "default",
        templates: DEFAULT_TEMPLATES.map((t) => ({ ...t })),
    };
}

export function activeTemplate(config) {
    for (const tpl of config.templates ?? []) {
        if (tpl.id === config.active_template_id)
            return tpl;
    }
    return (config.templates ?? DEFAULT_TEMPLATES)[0] ?? DEFAULT_TEMPLATES[0];
}

export class RagRuntimeConfigStore {
    filePath;

    constructor(filePath) {
        this.filePath = filePath;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    }

    static open(filePath) {
        return new RagRuntimeConfigStore(filePath);
    }

    load() {
        if (!fs.existsSync(this.filePath))
            return defaultRuntimeConfig();
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            const templates = Array.isArray(data.templates)
                ? data.templates
                : DEFAULT_TEMPLATES.map((t) => ({ ...t }));
            return {
                temperature: Number(data.temperature ?? 0.1),
                top_k: Number(data.top_k ?? 8),
                top_n: Number(data.top_n ?? 3),
                answer_mode: String(data.answer_mode ?? "direct"),
                use_rerank: data.use_rerank !== false,
                min_confidence_score: Number(data.min_confidence_score ?? 0.05),
                active_template_id: String(data.active_template_id ?? "default"),
                templates,
            };
        }
        catch {
            return defaultRuntimeConfig();
        }
    }

    save(config) {
        fs.writeFileSync(this.filePath, JSON.stringify(config, null, 2), "utf-8");
        return config;
    }

    update(patch) {
        const rc = this.load();
        if ("temperature" in patch)
            rc.temperature = Math.max(0, Math.min(2, Number(patch.temperature)));
        if ("top_k" in patch)
            rc.top_k = Math.max(1, Math.min(50, parseInt(String(patch.top_k), 10)));
        if ("top_n" in patch)
            rc.top_n = Math.max(1, Math.min(10, parseInt(String(patch.top_n), 10)));
        if ("answer_mode" in patch && ["direct", "generated"].includes(patch.answer_mode))
            rc.answer_mode = patch.answer_mode;
        if ("use_rerank" in patch)
            rc.use_rerank = Boolean(patch.use_rerank);
        if ("min_confidence_score" in patch)
            rc.min_confidence_score = Math.max(0, Math.min(1, Number(patch.min_confidence_score)));
        if ("active_template_id" in patch)
            rc.active_template_id = String(patch.active_template_id);
        if ("templates" in patch && Array.isArray(patch.templates)) {
            rc.templates = patch.templates
                .filter((t) => t && t.id)
                .map((t) => ({
                id: String(t.id),
                name: String(t.name ?? ""),
                content: String(t.content ?? ""),
            }));
        }
        return this.save(rc);
    }
}
