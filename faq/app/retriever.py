from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import faiss
import numpy as np

from .config import Settings, settings
from .data_loader import data_hash
from .database import connect, fetch_item, get_meta
from .embedding import EmbeddingClient
from .indexer import index_files_exist
from .llm import ModelClient
from .text_utils import char_ngrams, clip_text, keyword_text, strip_markdown
from .timing import ms_since


@dataclass
class ParentCandidate:
    item_id: str
    vector_score: float = 0.0
    keyword_score: float = 0.0
    rrf_score: float = 0.0
    rerank_score: float = 0.0
    matched_doc_types: set[str] = field(default_factory=set)
    matched_doc_ids: list[str] = field(default_factory=list)


def index_status(cfg: Settings = settings) -> dict[str, Any]:
    exists = cfg.db_path.is_file() and index_files_exist(cfg)
    if not exists:
        return {"ready": False, "stale": True, "reason": "索引不存在"}
    conn = connect(cfg)
    try:
        meta = get_meta(conn)
    finally:
        conn.close()
    current_hash = data_hash(cfg)
    stale = meta.get("data_hash") != current_hash
    if meta.get("embedding_model") not in {cfg.embedding_model, "hash-fallback"}:
        stale = True
    return {"ready": True, "stale": stale, "meta": meta, "reason": "索引过期" if stale else ""}


class Retriever:
    def __init__(self, cfg: Settings = settings, runtime=None):
        self.cfg = cfg
        self.runtime = runtime
        self.embedder = EmbeddingClient(cfg)
        self.models = ModelClient(cfg)
        self._faiss_index = None
        self._vector_docs: list[dict] | None = None

    def _rt(self, name: str, default):
        if self.runtime is None:
            return default
        return getattr(self.runtime, name, default)

    def search(self, query: str, *, top_k: int | None = None) -> tuple[list[dict], dict[str, float]]:
        top_k = top_k or self._rt("top_k", self.cfg.rerank_top_n)
        timing: dict[str, float] = {}
        t_total = time.perf_counter()

        vector_hits, vec_timing = self._vector_search(query, self.cfg.vector_top_k)
        timing.update(vec_timing)

        t0 = time.perf_counter()
        keyword_hits = self._keyword_search(query, self.cfg.keyword_top_k)
        timing["keyword_search_ms"] = ms_since(t0)

        t0 = time.perf_counter()
        candidates = self._fuse_and_group(vector_hits, keyword_hits)
        timing["fusion_ms"] = ms_since(t0)

        if not self._rt("use_rerank", True):
            candidates.sort(key=lambda c: c.rrf_score, reverse=True)
            timing["rerank_ms"] = 0.0
            results = [self._candidate_to_result(c) for c in candidates[:top_k]]
        else:
            t0 = time.perf_counter()
            ranked = self._rerank(query, candidates, top_k=max(top_k, self.cfg.rerank_top_n))
            timing["rerank_ms"] = ms_since(t0)
            results = [self._candidate_to_result(c) for c in ranked[:top_k]]

        timing["search_ms"] = ms_since(t_total)
        timing["total_ms"] = timing["search_ms"]
        return results, timing

    def chat(self, query: str, *, top_n: int | None = None, use_llm_answer: bool | None = None) -> dict:
        t_total = time.perf_counter()
        top_n = top_n or self._rt("top_n", self.cfg.answer_top_n)
        results, timing = self.search(query, top_k=max(top_n, self.cfg.rerank_top_n))
        min_conf = self._rt("min_confidence_score", self.cfg.min_confidence_score)
        high_conf = bool(results) and float(results[0].get("rerank_score") or results[0].get("rrf_score") or 0) >= min_conf
        if not high_conf:
            timing["generate_ms"] = 0.0
            timing["total_ms"] = ms_since(t_total)
            return {
                "answer": "未找到高置信答案。你可以换一种问法，或查看下方候选结果。",
                "confidence": 0.0,
                "sources": results[:top_n],
                "images": [],
                "mode": "no_high_confidence",
                "timing": timing,
            }
        sources = results[:top_n]
        rt_mode = self._rt("answer_mode", self.cfg.answer_mode)
        should_generate = rt_mode == "generated" or bool(use_llm_answer)
        if should_generate:
            t0 = time.perf_counter()
            answer = self.models.generate_answer(query, sources, runtime=self.runtime)
            timing["generate_ms"] = ms_since(t0)
            mode = "generated"
        else:
            answer = sources[0]["answer"]
            timing["generate_ms"] = 0.0
            mode = "direct"
        images = self._dedupe_images(sources)
        timing["total_ms"] = ms_since(t_total)
        return {
            "answer": answer,
            "confidence": float(sources[0].get("rerank_score") or sources[0].get("rrf_score") or 0),
            "sources": sources,
            "images": images,
            "mode": mode,
            "timing": timing,
        }

    def _load_vector(self):
        if self._faiss_index is not None and self._vector_docs is not None:
            return self._faiss_index, self._vector_docs
        index_path = self.cfg.vector_dir / "faiss.index"
        docs_path = self.cfg.vector_dir / "vector_docs.json"
        self._faiss_index = faiss.read_index(str(index_path))
        self._vector_docs = json.loads(docs_path.read_text(encoding="utf-8"))
        return self._faiss_index, self._vector_docs

    def _vector_search(self, query: str, limit: int) -> tuple[list[dict], dict[str, float]]:
        timing: dict[str, float] = {}
        index, docs = self._load_vector()
        t0 = time.perf_counter()
        q = np.asarray([self.embedder.embed_query(query)], dtype="float32")
        timing["embedding_ms"] = ms_since(t0)
        t0 = time.perf_counter()
        scores, ids = index.search(q, min(limit, len(docs)))
        timing["vector_lookup_ms"] = ms_since(t0)
        out: list[dict] = []
        conn = connect(self.cfg)
        try:
            for score, row_idx in zip(scores[0], ids[0]):
                if row_idx < 0 or row_idx >= len(docs):
                    continue
                doc_id = docs[int(row_idx)]["doc_id"]
                row = conn.execute("SELECT * FROM search_docs WHERE doc_id = ?", (doc_id,)).fetchone()
                if row:
                    item = dict(row)
                    item["score"] = float(score)
                    item["rank_source"] = "vector"
                    out.append(item)
        finally:
            conn.close()
        timing["vector_search_ms"] = round(timing["embedding_ms"] + timing["vector_lookup_ms"], 1)
        return out, timing

    def _keyword_search(self, query: str, limit: int) -> list[dict]:
        q_tokens = list(dict.fromkeys(char_ngrams(query, min_n=2, max_n=3)))[:48]
        conn = connect(self.cfg)
        try:
            rows: list[sqlite3.Row] = []
            if q_tokens:
                fts_query = " OR ".join(q_tokens)
                try:
                    rows = conn.execute(
                        """
                        SELECT s.*, bm25(search_docs_fts) AS rank
                        FROM search_docs_fts
                        JOIN search_docs s ON s.doc_id = search_docs_fts.doc_id
                        WHERE search_docs_fts MATCH ?
                        ORDER BY rank
                        LIMIT ?
                        """,
                        (fts_query, limit),
                    ).fetchall()
                except Exception:
                    rows = []
            if rows:
                return [
                    {
                        **dict(row),
                        "score": 1.0 / (rank + 1),
                        "rank_source": "keyword",
                    }
                    for rank, row in enumerate(rows)
                ]
            return self._keyword_fallback(conn, query, limit)
        finally:
            conn.close()

    def _keyword_fallback(self, conn: sqlite3.Connection, query: str, limit: int) -> list[dict]:
        q_tokens = set(char_ngrams(query, min_n=2, max_n=3))
        rows = conn.execute(
            "SELECT * FROM search_docs WHERE is_eval_holdout = 0"
        ).fetchall()
        scored: list[tuple[float, sqlite3.Row]] = []
        for row in rows:
            text = str(row["keyword_text"] or "")
            score = sum(1 for tok in q_tokens if tok and tok in text)
            if score:
                scored.append((float(score), row))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [
            {**dict(row), "score": score, "rank_source": "keyword"}
            for score, row in scored[:limit]
        ]

    def _fuse_and_group(self, vector_hits: list[dict], keyword_hits: list[dict]) -> list[ParentCandidate]:
        by_item: dict[str, ParentCandidate] = {}

        def add(hit: dict, rank: int, source: str) -> None:
            item_id = str(hit["item_id"])
            cand = by_item.setdefault(item_id, ParentCandidate(item_id=item_id))
            rrf = 1.0 / (self.cfg.rrf_k + rank)
            cand.rrf_score += rrf
            cand.matched_doc_types.add(str(hit["doc_type"]))
            doc_id = str(hit["doc_id"])
            if doc_id not in cand.matched_doc_ids:
                cand.matched_doc_ids.append(doc_id)
            score = float(hit.get("score") or 0.0)
            if source == "vector":
                cand.vector_score = max(cand.vector_score, score)
            else:
                cand.keyword_score = max(cand.keyword_score, score)

        for rank, hit in enumerate(vector_hits, 1):
            add(hit, rank, "vector")
        for rank, hit in enumerate(keyword_hits, 1):
            add(hit, rank, "keyword")
        out = list(by_item.values())
        out.sort(key=lambda c: c.rrf_score, reverse=True)
        return out

    def _rerank(self, query: str, candidates: list[ParentCandidate], top_k: int) -> list[ParentCandidate]:
        conn = connect(self.cfg)
        docs: list[str] = []
        kept: list[ParentCandidate] = []
        try:
            for cand in candidates[: max(top_k * 3, top_k)]:
                item = fetch_item(conn, cand.item_id)
                if not item:
                    continue
                variants = "；".join(v["variant"] for v in item.get("variants", [])[:8])
                docs.append(
                    f"主问题：{item['question']}\n相似问法：{variants}\n答案摘要：{item['answer_summary']}"
                )
                kept.append(cand)
        finally:
            conn.close()
        if not kept:
            return []
        ranked = self.models.rerank(query, docs, top_n=min(top_k, len(kept)))
        output: list[ParentCandidate] = []
        used: set[int] = set()
        for idx, score in ranked:
            if idx < 0 or idx >= len(kept) or idx in used:
                continue
            kept[idx].rerank_score = float(score)
            output.append(kept[idx])
            used.add(idx)
        if len(output) < min(top_k, len(kept)):
            for idx, cand in enumerate(kept):
                if idx not in used:
                    cand.rerank_score = cand.rrf_score
                    output.append(cand)
                if len(output) >= top_k:
                    break
        return output

    def _candidate_to_result(self, cand: ParentCandidate) -> dict:
        conn = connect(self.cfg)
        try:
            item = fetch_item(conn, cand.item_id)
        finally:
            conn.close()
        if not item:
            return {"id": cand.item_id}
        return {
            "id": item["id"],
            "question": item["question"],
            "answer": item["answer"],
            "answer_summary": item["answer_summary"],
            "updated_at": item["updated_at"],
            "images": item["images"],
            "variants": item["variants"],
            "vector_score": cand.vector_score,
            "keyword_score": cand.keyword_score,
            "rrf_score": cand.rrf_score,
            "rerank_score": cand.rerank_score,
            "matched_doc_types": sorted(cand.matched_doc_types),
            "matched_doc_ids": cand.matched_doc_ids,
        }

    @staticmethod
    def _dedupe_images(sources: list[dict]) -> list[dict]:
        seen: set[str] = set()
        images: list[dict] = []
        for src in sources:
            for image in src.get("images") or []:
                key = image.get("src") or image.get("url") or ""
                if key and key not in seen:
                    seen.add(key)
                    images.append(image)
        return images
