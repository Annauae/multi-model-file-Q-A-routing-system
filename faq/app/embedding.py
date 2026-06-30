from __future__ import annotations

import time
from hashlib import blake2b

import numpy as np
import requests

from .config import Settings, settings
from .text_utils import char_ngrams, clip_text


def normalize_matrix(vectors: np.ndarray) -> np.ndarray:
    arr = np.asarray(vectors, dtype="float32")
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


class EmbeddingClient:
    def __init__(self, cfg: Settings = settings):
        self.cfg = cfg

    @property
    def use_api(self) -> bool:
        return self.cfg.use_api_embedding and self.cfg.has_api_key

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dimension()), dtype="float32")
        backend = "api" if self.use_api else "hash"
        print(f"[embedding] {len(texts)} texts via {backend} backend", flush=True)
        if self.use_api:
            try:
                return self._embed_api(texts)
            except Exception as exc:
                print(f"[embedding] API embedding failed, using hash fallback: {exc}", flush=True)
        return self._embed_hash(texts)

    def embed_query(self, text: str) -> np.ndarray:
        return self.embed_texts([text])[0]

    def dimension(self) -> int:
        if not self.use_api:
            return int(self.cfg.hash_embedding_dim)
        # The API dimension is discovered while building the index. Query code reads metadata.
        return int(self.cfg.hash_embedding_dim)

    def _embed_api(self, texts: list[str]) -> np.ndarray:
        url = f"{self.cfg.siliconflow_base_url}/embeddings"
        headers = {
            "Authorization": f"Bearer {self.cfg.siliconflow_api_key}",
            "Content-Type": "application/json",
        }
        out: list[list[float]] = []
        step = max(1, int(self.cfg.embedding_batch_size))
        total = len(texts)
        last_pct = -1
        for start in range(0, total, step):
            batch = [
                clip_text(t.replace("\x00", " "), self.cfg.embedding_max_chars) or " "
                for t in texts[start : start + step]
            ]
            resp = requests.post(
                url,
                headers=headers,
                json={"model": self.cfg.embedding_model, "input": batch},
                timeout=120,
            )
            resp.raise_for_status()
            data = resp.json().get("data") or []
            ordered: list[list[float] | None] = [None] * len(batch)
            for item in data:
                ordered[int(item["index"])] = [float(x) for x in item["embedding"]]
            if any(v is None for v in ordered):
                raise RuntimeError("embedding API returned incomplete batch")
            out.extend(v for v in ordered if v is not None)
            done = min(start + step, total)
            pct = int(done * 100 / total)
            if pct != last_pct:
                print(f"[embedding] {done}/{total} ({pct}%)", flush=True)
                last_pct = pct
            if start + step < total and self.cfg.embedding_sleep_sec > 0:
                time.sleep(self.cfg.embedding_sleep_sec)
        return normalize_matrix(np.asarray(out, dtype="float32"))

    def _embed_hash(self, texts: list[str]) -> np.ndarray:
        dim = max(64, int(self.cfg.hash_embedding_dim))
        matrix = np.zeros((len(texts), dim), dtype="float32")
        for row, text in enumerate(texts):
            tokens = char_ngrams(text, min_n=1, max_n=3)
            if not tokens:
                tokens = ["empty"]
            for token in tokens:
                digest = blake2b(token.encode("utf-8"), digest_size=8).digest()
                value = int.from_bytes(digest, byteorder="little", signed=False)
                col = value % dim
                sign = 1.0 if ((value >> 8) & 1) else -1.0
                matrix[row, col] += sign
        return normalize_matrix(matrix)
