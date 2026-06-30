from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import Settings, ensure_runtime_dirs, settings
from .data_loader import FaqItem
from .media import refs_to_dicts


def connect(cfg: Settings = settings) -> sqlite3.Connection:
    ensure_runtime_dirs(cfg)
    conn = sqlite3.connect(cfg.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db_session(cfg: Settings = settings) -> Iterator[sqlite3.Connection]:
    conn = connect(cfg)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS faq_items (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          answer_text TEXT NOT NULL,
          answer_summary TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          images_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS faq_variants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id TEXT NOT NULL REFERENCES faq_items(id) ON DELETE CASCADE,
          variant TEXT NOT NULL,
          is_eval_holdout INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS faq_images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id TEXT NOT NULL REFERENCES faq_items(id) ON DELETE CASCADE,
          alt TEXT NOT NULL,
          src TEXT NOT NULL,
          url TEXT NOT NULL,
          file_exists INTEGER NOT NULL,
          kind TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS search_docs (
          doc_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES faq_items(id) ON DELETE CASCADE,
          doc_type TEXT NOT NULL,
          text TEXT NOT NULL,
          keyword_text TEXT NOT NULL,
          is_eval_holdout INTEGER NOT NULL DEFAULT 0,
          vector_row INTEGER
        );

        CREATE TABLE IF NOT EXISTS index_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS eval_runs (
          run_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          size INTEGER NOT NULL,
          mode TEXT NOT NULL,
          top_k INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          summary_json TEXT NOT NULL DEFAULT '{}',
          error TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS eval_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES eval_runs(run_id) ON DELETE CASCADE,
          sample_index INTEGER NOT NULL,
          query TEXT NOT NULL,
          expected_item_id TEXT NOT NULL,
          actual_item_id TEXT NOT NULL DEFAULT '',
          hit_top1 INTEGER NOT NULL DEFAULT 0,
          hit_top3 INTEGER NOT NULL DEFAULT 0,
          hit_top5 INTEGER NOT NULL DEFAULT 0,
          image_hit INTEGER NOT NULL DEFAULT 0,
          quality_score REAL,
          confidence REAL,
          groundedness REAL,
          image_support REAL,
          reason TEXT NOT NULL DEFAULT '',
          result_json TEXT NOT NULL DEFAULT '{}',
          judge_error TEXT NOT NULL DEFAULT ''
        );
        """
    )
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_fts "
            "USING fts5(doc_id UNINDEXED, item_id UNINDEXED, text, keyword_text)"
        )
    except sqlite3.OperationalError:
        # Some minimal SQLite builds omit FTS5; retriever falls back to LIKE scoring.
        pass


def reset_content(conn: sqlite3.Connection) -> None:
    for table in (
        "search_docs_fts",
        "search_docs",
        "faq_images",
        "faq_variants",
        "faq_items",
        "index_meta",
    ):
        try:
            conn.execute(f"DELETE FROM {table}")
        except sqlite3.OperationalError:
            continue


def upsert_items(conn: sqlite3.Connection, items: list[FaqItem]) -> None:
    for item in items:
        images = refs_to_dicts(item.images)
        conn.execute(
            """
            INSERT OR REPLACE INTO faq_items
              (id, question, answer, answer_text, answer_summary, enabled, updated_at, images_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.id,
                item.question,
                item.answer,
                item.answer_text,
                item.answer_summary,
                1 if item.enabled else 0,
                item.updated_at,
                json.dumps(images, ensure_ascii=False),
            ),
        )
        conn.execute("DELETE FROM faq_variants WHERE item_id = ?", (item.id,))
        conn.execute("DELETE FROM faq_images WHERE item_id = ?", (item.id,))
        for ref in images:
            conn.execute(
                """
                INSERT INTO faq_images (item_id, alt, src, url, file_exists, kind)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    item.id,
                    ref["alt"],
                    ref["src"],
                    ref["url"],
                    1 if ref["exists"] else 0,
                    ref["kind"],
                ),
            )


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)",
        (key, value),
    )


def get_meta(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT key, value FROM index_meta").fetchall()
    return {str(row["key"]): str(row["value"]) for row in rows}


def fetch_item(conn: sqlite3.Connection, item_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM faq_items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        return None
    item = dict(row)
    item["images"] = json.loads(item.pop("images_json") or "[]")
    variants = conn.execute(
        "SELECT variant, is_eval_holdout FROM faq_variants WHERE item_id = ? ORDER BY id",
        (item_id,),
    ).fetchall()
    item["variants"] = [dict(v) for v in variants]
    return item


def fetch_items_by_ids(conn: sqlite3.Connection, item_ids: list[str]) -> list[dict]:
    out: list[dict] = []
    for item_id in item_ids:
        item = fetch_item(conn, item_id)
        if item is not None:
            out.append(item)
    return out


def db_exists(cfg: Settings = settings) -> bool:
    return Path(cfg.db_path).is_file()
