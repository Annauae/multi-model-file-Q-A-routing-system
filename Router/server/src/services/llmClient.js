import OpenAI from "openai";
import { NONE_SENTINEL } from "./matcher.js";
export class LLMError extends Error {
    constructor(message) {
        super(message);
        this.name = "LLMError";
    }
}
export function tokenUsageToDict(u) {
    return {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.total_tokens || u.prompt_tokens + u.completion_tokens,
    };
}
function raiseFriendly(e) {
    const msg = String(e);
    if (msg.includes("401") || msg.includes("AuthenticationError") || msg.includes("API key")) {
        throw new LLMError("模型鉴权失败（401）。请检查「设置」页中对应模型的 API Key 是否正确，修改后需刷新页面或重启服务。");
    }
    if (msg.includes("403") || msg.includes("AccessDenied")) {
        throw new LLMError("上游模型无权限访问（403）。请确认 API_KEY 与接入点/模型匹配。");
    }
    throw new LLMError(`调用上游模型失败：${e instanceof Error ? e.message : msg}`);
}
export class LLMClient {
    settings;
    apiBaseUrl;
    apiKey;
    enableThinking;
    client = null;
    constructor(settings, apiBaseUrl = settings.apiBaseUrl, apiKey = settings.apiKey, enableThinking = settings.enableThinking) {
        this.settings = settings;
        this.apiBaseUrl = apiBaseUrl;
        this.apiKey = apiKey;
        this.enableThinking = enableThinking;
        if (!settings.mockLlm && !this.apiKey && !this.isOllama()) {
            throw new LLMError("未配置 API Key，无法调用模型。请在「设置」页填写 API Key，或选择 Ollama 本地模型（无需 Key）。");
        }
    }
    withCredentials(opts) {
        return new LLMClient(this.settings, opts.api_base_url, opts.api_key, opts.enable_thinking !== undefined ? opts.enable_thinking : this.enableThinking);
    }
    isOllama() {
        const url = (this.apiBaseUrl || "").toLowerCase();
        return url.includes(":11434") || url.replace(/\/$/, "").endsWith("/11434");
    }
    ollamaRootUrl() {
        let url = this.apiBaseUrl.replace(/\/$/, "");
        if (url.endsWith("/v1"))
            url = url.slice(0, -3);
        return url;
    }
    useOllamaNative() {
        return this.isOllama() && this.enableThinking === false;
    }
    getOpenAI() {
        if (!this.client) {
            this.client = new OpenAI({ baseURL: this.apiBaseUrl, apiKey: this.apiKey || "ollama" });
        }
        return this.client;
    }
    toOpenAIMessages(messages) {
        return messages.map((m) => {
            if (Array.isArray(m.content))
                return { role: m.role, content: m.content };
            if (this.settings.useContentParts && m.role === "user" && typeof m.content === "string") {
                return { role: m.role, content: [{ type: "text", text: m.content }] };
            }
            return { role: m.role, content: m.content };
        });
    }
    buildExtraBody(model) {
        const extra = {};
        const url = (this.apiBaseUrl || "").toLowerCase();
        if (url.includes("volces.com") && this.enableThinking != null) {
            extra.thinking = { type: this.enableThinking ? "enabled" : "disabled" };
        }
        else if (url.includes("generativelanguage.googleapis.com")) {
            if (this.enableThinking === false)
                extra.reasoning_effort = "none";
        }
        else if (this.enableThinking != null && !model.toLowerCase().includes("gpt-")) {
            extra.chat_template_kwargs = { enable_thinking: this.enableThinking };
        }
        if (this.settings.reasoningEffort && !url.includes("generativelanguage.googleapis.com")) {
            extra.reasoning_effort = this.settings.reasoningEffort;
        }
        return extra;
    }
    ollamaMessages(messages) {
        return messages.map((m) => {
            let content = "";
            if (Array.isArray(m.content)) {
                content = m.content
                    .filter((p) => p.type === "text")
                    .map((p) => String(p.text ?? ""))
                    .join("\n");
            }
            else {
                content = String(m.content ?? "");
            }
            return { role: m.role, content };
        });
    }
    async ollamaPost(path, payload) {
        const url = `${this.ollamaRootUrl()}${path}`;
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const detail = await resp.text();
            throw new LLMError(`Ollama 请求失败（${resp.status}）：${detail}`);
        }
        return (await resp.json());
    }
    async *ollamaStream(path, payload) {
        const url = `${this.ollamaRootUrl()}${path}`;
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const detail = await resp.text();
            throw new LLMError(`Ollama 流式请求失败（${resp.status}）：${detail}`);
        }
        const reader = resp.body?.getReader();
        if (!reader)
            return;
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
                const t = line.trim();
                if (!t)
                    continue;
                try {
                    yield JSON.parse(t);
                }
                catch {
                    /* skip */
                }
            }
        }
    }
    mockMatch(messages) {
        const userText = [...messages].reverse().find((m) => m.role === "user");
        let q = typeof userText?.content === "string" ? userText.content : String(userText?.content ?? "");
        q = q.trim().toLowerCase();
        if (!q || q.includes("不知道") || q.includes("无关"))
            return NONE_SENTINEL;
        const system = messages.find((m) => m.role === "system");
        const systemText = typeof system?.content === "string" ? system.content : "";
        for (const line of systemText.split(/\r?\n/)) {
            const t = line.trim();
            if (!t.includes("|"))
                continue;
            const [itemId, question] = t.split("|", 2);
            const id = itemId.trim();
            const qq = question.trim().toLowerCase();
            if (!id || id.startsWith("("))
                continue;
            if (q.includes(qq) || qq.slice(0, 4) && q.includes(qq.slice(0, 4)))
                return id;
        }
        return "q001";
    }
    mockConfidence(messages) {
        const userText = [...messages].reverse().find((m) => m.role === "user");
        let q = typeof userText?.content === "string" ? userText.content : "";
        q = q.trim().toLowerCase();
        if (!q || q.includes("不知道") || q.includes("无关"))
            return "[]";
        const hits = [];
        const system = messages.find((m) => m.role === "system");
        const systemText = typeof system?.content === "string" ? system.content : "";
        for (const line of systemText.split(/\r?\n/)) {
            const t = line.trim();
            if (!t.includes("|"))
                continue;
            const [itemId, question] = t.split("|", 2);
            const id = itemId.trim();
            const qq = question.trim().toLowerCase();
            if (!id || id.startsWith("("))
                continue;
            let score = 0;
            if (q.includes(qq) || qq.includes(q))
                score = 0.92;
            else if (qq.slice(0, 4) && q.includes(qq.slice(0, 4)))
                score = 0.55;
            if (score > 0 && !hits.some((h) => h[0] === id))
                hits.push([id, score]);
        }
        if (!hits.length)
            hits.push(["q001", 0.75]);
        hits.sort((a, b) => b[1] - a[1]);
        return JSON.stringify(hits.slice(0, 5).map(([id, confidence]) => ({ id, confidence })));
    }
    async chat(opts) {
        if (this.settings.mockLlm) {
            const text = this.mockMatch(opts.messages);
            const ct = Math.max(1, text.split(/\s+/).length);
            return [text, { prompt_tokens: 0, completion_tokens: ct, total_tokens: ct }];
        }
        const tokenLimit = opts.max_tokens ?? this.settings.maxTokens;
        const temp = opts.temperature ?? this.settings.matchTemperature;
        if (this.useOllamaNative()) {
            const data = await this.ollamaPost("/api/chat", {
                model: opts.model,
                messages: this.ollamaMessages(opts.messages),
                stream: false,
                think: false,
                options: { num_predict: tokenLimit, temperature: temp },
            });
            const msg = data.message ?? {};
            const text = String(msg.content ?? "").trim();
            const pt = Number(data.prompt_eval_count ?? 0);
            const ct = Number(data.eval_count ?? 0);
            return [text, { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct || Math.max(1, text.split(/\s+/).length) }];
        }
        try {
            const extra = this.buildExtraBody(opts.model);
            const kwargs = {
                model: opts.model,
                messages: this.toOpenAIMessages(opts.messages),
                temperature: temp,
                ...(this.settings.useMaxCompletionTokens
                    ? { max_completion_tokens: tokenLimit }
                    : { max_tokens: tokenLimit }),
                ...(Object.keys(extra).length ? { ...{ extra_body: extra } } : {}),
            };
            const resp = await this.getOpenAI().chat.completions.create(kwargs);
            const text = (resp.choices[0]?.message?.content ?? "").trim();
            const u = resp.usage;
            return [
                text,
                {
                    prompt_tokens: u?.prompt_tokens ?? 0,
                    completion_tokens: u?.completion_tokens ?? Math.max(1, text.split(/\s+/).length),
                    total_tokens: u?.total_tokens ?? 0,
                },
            ];
        }
        catch (e) {
            raiseFriendly(e);
        }
    }
    async *chatStream(opts) {
        if (this.settings.mockLlm) {
            const text = opts.mock_mode === "confidence"
                ? this.mockConfidence(opts.messages)
                : this.mockMatch(opts.messages);
            const ct = Math.max(1, text.split(/\s+/).length);
            opts.usage_out?.push({ prompt_tokens: 0, completion_tokens: ct, total_tokens: ct });
            for (let i = 0; i < text.length; i += 2)
                yield text.slice(i, i + 2);
            return;
        }
        const tokenLimit = opts.max_tokens ?? this.settings.maxTokens;
        const temp = opts.temperature ?? this.settings.matchTemperature;
        if (this.useOllamaNative()) {
            let lastUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
            let buffer = "";
            for await (const data of this.ollamaStream("/api/chat", {
                model: opts.model,
                messages: this.ollamaMessages(opts.messages),
                stream: true,
                think: false,
                options: { num_predict: tokenLimit, temperature: temp },
            })) {
                const msg = data.message ?? {};
                const content = String(msg.content ?? "");
                if (content) {
                    buffer += content;
                    yield content;
                }
                if (data.done) {
                    const pt = Number(data.prompt_eval_count ?? 0);
                    const ct = Number(data.eval_count ?? 0);
                    lastUsage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct || Math.max(1, buffer.split(/\s+/).length) };
                }
            }
            opts.usage_out?.push(lastUsage);
            return;
        }
        try {
            const extra = this.buildExtraBody(opts.model);
            const stream = await this.getOpenAI().chat.completions.create({
                model: opts.model,
                messages: this.toOpenAIMessages(opts.messages),
                temperature: temp,
                stream: true,
                ...(this.settings.useMaxCompletionTokens
                    ? { max_completion_tokens: tokenLimit }
                    : { max_tokens: tokenLimit }),
                ...(Object.keys(extra).length ? { ...{ extra_body: extra } } : {}),
            });
            let buffer = "";
            let lastUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
            for await (const chunk of stream) {
                if (chunk.usage) {
                    lastUsage = {
                        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                        completion_tokens: chunk.usage.completion_tokens ?? 0,
                        total_tokens: chunk.usage.total_tokens ?? 0,
                    };
                }
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    buffer += content;
                    yield content;
                }
            }
            if (!lastUsage.total_tokens && buffer) {
                lastUsage = { prompt_tokens: 0, completion_tokens: Math.max(1, buffer.split(/\s+/).length), total_tokens: 0 };
            }
            opts.usage_out?.push(lastUsage);
        }
        catch (e) {
            raiseFriendly(e);
        }
    }
}
