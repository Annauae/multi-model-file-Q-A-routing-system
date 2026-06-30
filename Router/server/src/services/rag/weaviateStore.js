/**
 * Weaviate REST client with optional in-memory mock (MOCK_WEAVIATE=1).
 */

export class MockWeaviateStore {
    objects = new Map();

    async ensureSchema() {
        return true;
    }

    async deleteByKbId(kbId) {
        for (const key of [...this.objects.keys()]) {
            if (key.startsWith(`${kbId}::`))
                this.objects.delete(key);
        }
    }

    async upsertBatch(kbId, rows) {
        for (const row of rows) {
            const key = `${kbId}::${row.doc_id}`;
            this.objects.set(key, { ...row, kbId });
        }
    }

    async hybridSearch(kbId, query, vector, limit, alpha = 0.5) {
        const hits = [];
        for (const obj of this.objects.values()) {
            if (obj.kbId !== kbId || obj.is_eval_holdout)
                continue;
            let vecScore = 0;
            if (vector?.length && obj.vector?.length) {
                let dot = 0;
                for (let i = 0; i < Math.min(vector.length, obj.vector.length); i++)
                    dot += vector[i] * obj.vector[i];
                vecScore = dot;
            }
            let kwScore = 0;
            const q = (query || "").toLowerCase();
            const text = `${obj.text || ""} ${obj.keyword_text || ""}`.toLowerCase();
            if (q && text.includes(q))
                kwScore = 1;
            else if (q) {
                for (const ch of q) {
                    if (text.includes(ch))
                        kwScore += 0.01;
                }
            }
            const score = alpha * vecScore + (1 - alpha) * kwScore;
            if (score > 0) {
                hits.push({
                    doc_id: obj.doc_id,
                    item_id: obj.item_id,
                    doc_type: obj.doc_type,
                    text: obj.text,
                    keyword_text: obj.keyword_text,
                    score,
                    rank_source: alpha >= 0.5 ? "vector" : "keyword",
                });
            }
        }
        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, limit);
    }

    async ping() {
        return { ok: true, mock: true };
    }
}

export class WeaviateStore {
    settings;
    className;
    baseUrl;
    headers;

    constructor(settings) {
        this.settings = settings;
        this.className = settings.weaviateClass || "FaqSearchDoc";
        const url = settings.weaviateUrl.replace(/\/$/, "");
        this.baseUrl = url.endsWith("/v1") ? url : `${url}/v1`;
        this.headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.weaviateApiKey}`,
        };
    }

    async request(method, path, body) {
        const resp = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: this.headers,
            body: body != null ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(120_000),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Weaviate ${method} ${path}: ${resp.status} ${text}`);
        }
        if (resp.status === 204)
            return null;
        return resp.json();
    }

    async ping() {
        await this.request("GET", "/schema");
        return { ok: true, mock: false };
    }

    async ensureSchema() {
        const schema = await this.request("GET", "/schema");
        const classes = schema?.classes ?? [];
        if (classes.some((c) => c.class === this.className))
            return true;
        await this.request("POST", "/schema", {
            class: this.className,
            vectorizer: "none",
            properties: [
                { name: "docId", dataType: ["text"], tokenization: "field" },
                { name: "itemId", dataType: ["text"], tokenization: "field" },
                { name: "kbId", dataType: ["text"], tokenization: "field" },
                { name: "docType", dataType: ["text"], tokenization: "field" },
                { name: "text", dataType: ["text"] },
                { name: "keywordText", dataType: ["text"] },
                { name: "isEvalHoldout", dataType: ["boolean"] },
            ],
        });
        return true;
    }

    async deleteByKbId(kbId) {
        await this.ensureSchema();
        try {
            await fetch(`${this.baseUrl}/batch/objects`, {
                method: "DELETE",
                headers: this.headers,
                body: JSON.stringify({
                    match: {
                        class: this.className,
                        where: {
                            path: ["kbId"],
                            operator: "Equal",
                            valueText: String(kbId),
                        },
                    },
                }),
                signal: AbortSignal.timeout(120_000),
            });
        }
        catch (err) {
            console.warn(`[weaviate] deleteByKbId ${kbId}: ${err}`);
        }
    }

    async upsertBatch(kbId, rows) {
        if (!rows.length)
            return;
        await this.ensureSchema();
        const objects = rows.map((row) => ({
            class: this.className,
            properties: {
                docId: row.doc_id,
                itemId: row.item_id,
                kbId: String(kbId),
                docType: row.doc_type,
                text: row.text,
                keywordText: row.keyword_text,
                isEvalHoldout: Boolean(row.is_eval_holdout),
            },
            vector: row.vector,
        }));
        const batchSize = 50;
        for (let i = 0; i < objects.length; i += batchSize) {
            const chunk = objects.slice(i, i + batchSize);
            await this.request("POST", "/batch/objects", { objects: chunk });
        }
    }

    async hybridSearch(kbId, query, vector, limit, alpha = 0.5) {
        await this.ensureSchema();
        const where = `{ path: ["kbId"], operator: Equal, valueText: "${String(kbId).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" }`;
        const lim = Math.max(1, limit);

        if (alpha >= 0.5 && vector?.length) {
            const vecStr = vector.map((v) => Number(v).toFixed(8)).join(", ");
            const gql = `{ Get { ${this.className}(nearVector: { vector: [${vecStr}] }, where: ${where}, limit: ${lim}) { docId itemId docType text keywordText _additional { distance id } } } }`;
            const data = await this.request("POST", "/graphql", { query: gql });
            const rows = data?.data?.Get?.[this.className] ?? [];
            return rows.map((row) => ({
                doc_id: row.docId,
                item_id: row.itemId,
                doc_type: row.docType,
                text: row.text,
                keyword_text: row.keywordText,
                score: 1 - Number(row._additional?.distance ?? 1),
                rank_source: "vector",
            }));
        }

        const qEsc = String(query || " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const gql = `{ Get { ${this.className}(bm25: { query: "${qEsc}" }, where: ${where}, limit: ${lim}) { docId itemId docType text keywordText _additional { score id } } } }`;
        try {
            const data = await this.request("POST", "/graphql", { query: gql });
            const rows = data?.data?.Get?.[this.className] ?? [];
            return rows.map((row) => ({
                doc_id: row.docId,
                item_id: row.itemId,
                doc_type: row.docType,
                text: row.text,
                keyword_text: row.keywordText,
                score: Number(row._additional?.score ?? 0),
                rank_source: "keyword",
            }));
        }
        catch {
            return [];
        }
    }
}

export function createWeaviateStore(settings) {
    if (settings.mockWeaviate || !settings.weaviateUrl)
        return new MockWeaviateStore();
    return new WeaviateStore(settings);
}
