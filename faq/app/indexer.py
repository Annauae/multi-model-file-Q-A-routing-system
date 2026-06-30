from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import faiss
import numpy as np

from .config import Settings, ensure_runtime_dirs, settings
from .data_loader import FaqItem, data_hash, load_faq_items
from .database import db_session, init_db, reset_content, set_meta, upsert_items
from .embedding import EmbeddingClient
from .text_utils import keyword_text, stable_hash


@dataclass(frozen=True)
class SearchDoc:
    doc_id: str
    item_id: str
    doc_type: str
    text: str
    keyword_text: str
    is_eval_holdout: bool = False


def _holdout_variants(item: FaqItem, count: int) -> set[str]:
    if count <= 0 or not item.variants:
        return set()
    ranked = sorted(item.variants, key=lambda v: stable_hash(f"{item.id}:{v}"))
    return set(ranked[: min(count, len(ranked))])


def build_search_docs(item: FaqItem, holdouts: set[str]) -> list[SearchDoc]:
    docs: list[SearchDoc] = []
    question_text = f"问题：{item.question}\n答案摘要：{item.answer_summary}"
    docs.append(
        SearchDoc(
            doc_id=f"{item.id}::question",
            item_id=item.id,
            doc_type="question",
            text=question_text,
            keyword_text=keyword_text([item.question, item.answer_summary]),
        )
    )
    for idx, variant in enumerate(item.variants):
        is_holdout = variant in holdouts
        docs.append(
            SearchDoc(
                doc_id=f"{item.id}::variant::{idx}",
                item_id=item.id,
                doc_type="variant",
                text=f"相似问法：{variant}\n主问题：{item.question}\n答案摘要：{item.answer_summary}",
                keyword_text=keyword_text([variant, item.question, item.answer_summary]),
                is_eval_holdout=is_holdout,
            )
        )
    docs.append(
        SearchDoc(
            doc_id=f"{item.id}::answer_summary",
            item_id=item.id,
            doc_type="answer_summary",
            text=f"主问题：{item.question}\n答案摘要：{item.answer_summary}",
            keyword_text=keyword_text([item.question, item.answer_summary]),
        )
    )
    return docs


def _write_vector_index(cfg: Settings, docs: list[SearchDoc], embeddings: np.ndarray) -> None:
    cfg.vector_dir.mkdir(parents=True, exist_ok=True)
    index_path = cfg.vector_dir / "faiss.index"
    docs_path = cfg.vector_dir / "vector_docs.json"
    dim = int(embeddings.shape[1])
    index = faiss.IndexFlatIP(dim)
    index.add(np.asarray(embeddings, dtype="float32"))
    faiss.write_index(index, str(index_path))
    docs_path.write_text(
        json.dumps(
            [{"row": i, "doc_id": doc.doc_id, "item_id": doc.item_id} for i, doc in enumerate(docs)],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def rebuild_index(cfg: Settings = settings) -> dict:
    ensure_runtime_dirs(cfg)
    print(f"[index] loading FAQ from {cfg.data_path}", flush=True)
    items = load_faq_items(cfg)
    print(f"[index] enabled items: {len(items)}", flush=True)
    now = datetime.now(timezone.utc).isoformat()
    embedder = EmbeddingClient(cfg)
    backend = "api" if embedder.use_api else "hash-fallback"

    all_docs: list[SearchDoc] = []
    indexed_docs: list[SearchDoc] = []
    holdout_count = int(cfg.eval_holdout_per_item)

    with db_session(cfg) as conn:
        init_db(conn)
        reset_content(conn)
        upsert_items(conn, items)
        print("[index] writing FAQ items and variants", flush=True)

        for item in items:
            holdouts = _holdout_variants(item, holdout_count)
            for variant in item.variants:
                conn.execute(
                    """
                    INSERT INTO faq_variants (item_id, variant, is_eval_holdout)
                    VALUES (?, ?, ?)
                    """,
                    (item.id, variant, 1 if variant in holdouts else 0),
                )
            docs = build_search_docs(item, holdouts)
            all_docs.extend(docs)
            indexed_docs.extend([doc for doc in docs if not doc.is_eval_holdout])

        print(
            f"[index] search docs: {len(indexed_docs)} indexed, "
            f"{len(all_docs) - len(indexed_docs)} holdout",
            flush=True,
        )
        print(f"[index] embedding {len(indexed_docs)} docs ({backend})…", flush=True)
        embeddings = embedder.embed_texts([doc.text for doc in indexed_docs])
        print("[index] writing FAISS index and search_docs rows", flush=True)
        _write_vector_index(cfg, indexed_docs, embeddings)

        vector_row_by_doc = {doc.doc_id: i for i, doc in enumerate(indexed_docs)}
        for doc in all_docs:
            row_id = vector_row_by_doc.get(doc.doc_id)
            conn.execute(
                """
                INSERT INTO search_docs
                  (doc_id, item_id, doc_type, text, keyword_text, is_eval_holdout, vector_row)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    doc.doc_id,
                    doc.item_id,
                    doc.doc_type,
                    doc.text,
                    doc.keyword_text,
                    1 if doc.is_eval_holdout else 0,
                    row_id,
                ),
            )
            if not doc.is_eval_holdout:
                try:
                    conn.execute(
                        "INSERT INTO search_docs_fts (doc_id, item_id, text, keyword_text) "
                        "VALUES (?, ?, ?, ?)",
                        (doc.doc_id, doc.item_id, doc.text, doc.keyword_text),
                    )
                except Exception:
                    pass

        dim = int(embeddings.shape[1]) if len(indexed_docs) else 0
        meta = {
            "data_hash": data_hash(cfg),
            "embedding_model": cfg.embedding_model if embedder.use_api else "hash-fallback",
            "embedding_dim": str(dim),
            "built_at": now,
            "items": str(len(items)),
            "search_docs": str(len(indexed_docs)),
            "holdout_docs": str(len(all_docs) - len(indexed_docs)),
        }
        for key, value in meta.items():
            set_meta(conn, key, value)

    return meta


def index_files_exist(cfg: Settings = settings) -> bool:
    return (cfg.vector_dir / "faiss.index").is_file() and (cfg.vector_dir / "vector_docs.json").is_file()
