import crypto from "node:crypto";
import { charNgrams, clipText } from "./textUtils.js";

export function normalizeMatrix(vectors) {
    return vectors.map((row) => {
        const norm = Math.sqrt(row.reduce((sum, v) => sum + v * v, 0)) || 1;
        return row.map((v) => v / norm);
    });
}

export function cosineSimilarity(a, b) {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++)
        dot += a[i] * b[i];
    return dot;
}

export class EmbeddingClient {
    settings;
    ragModelsStore;
    dimensionCache = null;

    constructor(settings, ragModelsStore) {
        this.settings = settings;
        this.ragModelsStore = ragModelsStore;
    }

    get useApi() {
        const cfg = this.ragModelsStore.getSlot("embedding");
        return this.settings.useApiEmbedding && Boolean(cfg.api_key?.trim());
    }

    dimension() {
        if (this.dimensionCache != null)
            return this.dimensionCache;
        return this.settings.hashEmbeddingDim;
    }

    async embedTexts(texts) {
        if (!texts.length)
            return [];
        if (this.useApi) {
            try {
                const vectors = await this.embedApi(texts);
                if (vectors.length && vectors[0].length)
                    this.dimensionCache = vectors[0].length;
                return vectors;
            }
            catch (err) {
                console.warn(`[embedding] API embedding failed, using hash fallback: ${err}`);
            }
        }
        return this.embedHash(texts);
    }

    async embedQuery(text) {
        const [vec] = await this.embedTexts([text]);
        return vec ?? [];
    }

    async embedApi(texts) {
        const cfg = this.ragModelsStore.getSlot("embedding");
        const url = `${cfg.api_base_url.replace(/\/$/, "")}/embeddings`;
        const headers = {
            Authorization: `Bearer ${cfg.api_key}`,
            "Content-Type": "application/json",
        };
        const out = [];
        const step = Math.max(1, this.settings.embeddingBatchSize);
        for (let start = 0; start < texts.length; start += step) {
            const batch = texts.slice(start, start + step).map((t) => clipText(t.replace(/\x00/g, " "), this.settings.embeddingMaxChars) || " ");
            const resp = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ model: cfg.model, input: batch }),
                signal: AbortSignal.timeout(120_000),
            });
            if (!resp.ok)
                throw new Error(await resp.text());
            const data = await resp.json();
            const ordered = new Array(batch.length).fill(null);
            for (const item of data.data ?? []) {
                ordered[item.index] = item.embedding.map(Number);
            }
            if (ordered.some((v) => v == null))
                throw new Error("embedding API returned incomplete batch");
            out.push(...ordered);
            if (start + step < texts.length && this.settings.embeddingSleepSec > 0) {
                await new Promise((r) => setTimeout(r, this.settings.embeddingSleepSec * 1000));
            }
        }
        return normalizeMatrix(out);
    }

    embedHash(texts) {
        const dim = Math.max(64, this.settings.hashEmbeddingDim);
        const matrix = texts.map(() => new Array(dim).fill(0));
        for (let row = 0; row < texts.length; row++) {
            let tokens = charNgrams(texts[row], 1, 3);
            if (!tokens.length)
                tokens = ["empty"];
            for (const token of tokens) {
                const digest = crypto.createHash("blake2b512").update(token, "utf-8").digest().subarray(0, 8);
                const value = digest.readUInt32LE(0);
                const col = value % dim;
                const sign = (value >> 8) & 1 ? 1 : -1;
                matrix[row][col] += sign;
            }
        }
        this.dimensionCache = dim;
        return normalizeMatrix(matrix);
    }
}
