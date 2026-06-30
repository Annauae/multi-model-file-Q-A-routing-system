from __future__ import annotations

import json
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from .config import Settings, settings
from .database import connect, db_session, fetch_item
from .llm import ModelClient
from .retriever import Retriever
from .timing import ms_since


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sample_rows(mode: str, size: int, cfg: Settings) -> list[dict]:
    conn = connect(cfg)
    try:
        rows: list[dict] = []
        if mode == "question":
            rows = [
                {"query": row["question"], "expected_item_id": row["id"], "sample_type": "question"}
                for row in conn.execute(
                    "SELECT id, question FROM faq_items WHERE enabled = 1"
                ).fetchall()
            ]
        elif mode in {"indexed_variant", "holdout_variant"}:
            holdout = 1 if mode == "holdout_variant" else 0
            rows = [
                {
                    "query": row["variant"],
                    "expected_item_id": row["item_id"],
                    "sample_type": mode,
                }
                for row in conn.execute(
                    "SELECT item_id, variant FROM faq_variants WHERE is_eval_holdout = ?",
                    (holdout,),
                ).fetchall()
            ]
        else:
            holdout = [
                {
                    "query": row["variant"],
                    "expected_item_id": row["item_id"],
                    "sample_type": "holdout_variant",
                }
                for row in conn.execute(
                    "SELECT item_id, variant FROM faq_variants WHERE is_eval_holdout = 1"
                ).fetchall()
            ]
            questions = [
                {"query": row["question"], "expected_item_id": row["id"], "sample_type": "question"}
                for row in conn.execute(
                    "SELECT id, question FROM faq_items WHERE enabled = 1"
                ).fetchall()
            ]
            rows = holdout + questions
    finally:
        conn.close()
    if not rows:
        return []
    k = min(size, len(rows))
    return random.sample(rows, k)


def start_eval_run(
    *,
    size: int,
    mode: str = "mixed",
    top_k: int | None = None,
    use_llm_answer: bool = False,
    cfg: Settings = settings,
) -> str:
    if size not in {10, 50, 100}:
        raise ValueError("size must be one of 10, 50, 100")
    top_k = top_k or cfg.eval_default_top_k
    run_id = uuid.uuid4().hex
    now = _now()
    with db_session(cfg) as conn:
        conn.execute(
            """
            INSERT INTO eval_runs
              (run_id, status, size, mode, top_k, created_at, updated_at, summary_json)
            VALUES (?, 'queued', ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                size,
                mode,
                top_k,
                now,
                now,
                json.dumps({"processed": 0, "total": size}, ensure_ascii=False),
            ),
        )
    thread = threading.Thread(
        target=_run_eval,
        kwargs={
            "run_id": run_id,
            "size": size,
            "mode": mode,
            "top_k": top_k,
            "use_llm_answer": use_llm_answer,
            "cfg": cfg,
        },
        daemon=True,
    )
    thread.start()
    return run_id


def _run_eval(run_id: str, size: int, mode: str, top_k: int, use_llm_answer: bool, cfg: Settings) -> None:
    retriever = Retriever(cfg)
    judge = ModelClient(cfg)
    samples = _sample_rows(mode, size, cfg)
    total = len(samples)
    try:
        with db_session(cfg) as conn:
            conn.execute(
                "UPDATE eval_runs SET status = 'running', updated_at = ?, summary_json = ? WHERE run_id = ?",
                (_now(), json.dumps({"processed": 0, "total": total}, ensure_ascii=False), run_id),
            )
        for idx, sample in enumerate(samples, start=1):
            query = sample["query"]
            expected_id = sample["expected_item_id"]
            t_sample = time.perf_counter()
            chat = retriever.chat(query, top_n=top_k, use_llm_answer=use_llm_answer)
            item_timing = dict(chat.get("timing") or {})
            sources = chat.get("sources") or []
            retrieved_ids = [src.get("id") for src in sources]
            actual_id = str(retrieved_ids[0] or "") if retrieved_ids else ""
            expected_item = _fetch_expected(expected_id, cfg)
            expected_images = expected_item.get("images") or []
            actual_images = chat.get("images") or []
            image_hit = _image_hit(expected_images, actual_images)
            t_judge = time.perf_counter()
            judge_result = judge.judge(
                query=query,
                expected_answer=expected_item.get("answer") or "",
                actual_answer=chat.get("answer") or "",
                sources=sources,
            )
            item_timing["judge_ms"] = ms_since(t_judge)
            item_timing["total_ms"] = ms_since(t_sample)
            result_payload = {
                "query": query,
                "expected_item_id": expected_id,
                "expected_question": expected_item.get("question") or "",
                "expected_answer": expected_item.get("answer") or "",
                "expected_images": expected_images,
                "actual_item_id": actual_id,
                "retrieved_ids": retrieved_ids,
                "answer": chat.get("answer") or "",
                "sources": sources,
                "images": actual_images,
                "sample_type": sample.get("sample_type", mode),
                "timing": item_timing,
            }
            with db_session(cfg) as conn:
                conn.execute(
                    """
                    INSERT INTO eval_results
                      (run_id, sample_index, query, expected_item_id, actual_item_id,
                       hit_top1, hit_top3, hit_top5, image_hit, quality_score,
                       confidence, groundedness, image_support, reason, result_json, judge_error)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        idx,
                        query,
                        expected_id,
                        actual_id,
                        1 if retrieved_ids[:1] and expected_id in retrieved_ids[:1] else 0,
                        1 if expected_id in retrieved_ids[:3] else 0,
                        1 if expected_id in retrieved_ids[:5] else 0,
                        1 if image_hit else 0,
                        _float_or_none(judge_result.get("quality_score")),
                        _float_or_none(judge_result.get("confidence")),
                        _float_or_none(judge_result.get("groundedness")),
                        _float_or_none(judge_result.get("image_support")),
                        str(judge_result.get("reason") or ""),
                        json.dumps(result_payload, ensure_ascii=False),
                        str(judge_result.get("judge_error") or ""),
                    ),
                )
                summary = _summarize(conn, run_id, total=total, processed=idx)
                conn.execute(
                    "UPDATE eval_runs SET updated_at = ?, summary_json = ? WHERE run_id = ?",
                    (_now(), json.dumps(summary, ensure_ascii=False), run_id),
                )
        with db_session(cfg) as conn:
            summary = _summarize(conn, run_id, total=total, processed=total)
            conn.execute(
                """
                UPDATE eval_runs
                SET status = 'completed', updated_at = ?, completed_at = ?, summary_json = ?
                WHERE run_id = ?
                """,
                (_now(), _now(), json.dumps(summary, ensure_ascii=False), run_id),
            )
    except Exception as exc:
        with db_session(cfg) as conn:
            conn.execute(
                "UPDATE eval_runs SET status = 'failed', updated_at = ?, error = ? WHERE run_id = ?",
                (_now(), str(exc), run_id),
            )


def get_eval_run(run_id: str, cfg: Settings = settings) -> dict | None:
    conn = connect(cfg)
    try:
        run = conn.execute("SELECT * FROM eval_runs WHERE run_id = ?", (run_id,)).fetchone()
        if not run:
            return None
        results = conn.execute(
            "SELECT * FROM eval_results WHERE run_id = ? ORDER BY sample_index",
            (run_id,),
        ).fetchall()
        out = dict(run)
        out["summary"] = json.loads(out.pop("summary_json") or "{}")
        out["results"] = []
        for row in results:
            item = dict(row)
            item["result"] = json.loads(item.pop("result_json") or "{}")
            out["results"].append(item)
        return out
    finally:
        conn.close()


def latest_eval_runs(limit: int = 10, cfg: Settings = settings) -> list[dict]:
    conn = connect(cfg)
    try:
        rows = conn.execute(
            "SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["summary"] = json.loads(item.pop("summary_json") or "{}")
            out.append(item)
        return out
    finally:
        conn.close()


def _fetch_expected(item_id: str, cfg: Settings) -> dict:
    conn = connect(cfg)
    try:
        return fetch_item(conn, item_id) or {}
    finally:
        conn.close()


def _image_hit(expected_images: list[dict], actual_images: list[dict]) -> bool:
    if not expected_images:
        return True
    actual = {img.get("src") for img in actual_images}
    expected = {img.get("src") for img in expected_images}
    return bool(actual & expected)


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _summarize(conn, run_id: str, *, total: int, processed: int) -> dict:
    rows = conn.execute("SELECT * FROM eval_results WHERE run_id = ?", (run_id,)).fetchall()
    n = max(1, len(rows))

    def avg(field: str) -> float:
        vals = [float(row[field]) for row in rows if row[field] is not None]
        return round(sum(vals) / len(vals), 4) if vals else 0.0

    timing_keys = [
        "embedding_ms",
        "vector_lookup_ms",
        "keyword_search_ms",
        "fusion_ms",
        "rerank_ms",
        "generate_ms",
        "judge_ms",
        "search_ms",
        "total_ms",
    ]
    timing_sums = {k: 0.0 for k in timing_keys}
    timing_count = 0
    for row in rows:
        try:
            payload = json.loads(row["result_json"] or "{}")
        except Exception:
            continue
        timing = payload.get("timing") or {}
        if not timing:
            continue
        timing_count += 1
        for key in timing_keys:
            if key in timing:
                timing_sums[key] += float(timing[key])

    avg_timing = {
        key: round(timing_sums[key] / timing_count, 1) if timing_count else 0.0
        for key in timing_keys
    }

    return {
        "processed": processed,
        "total": total,
        "recall_at_1": round(sum(int(r["hit_top1"]) for r in rows) / n, 4),
        "recall_at_3": round(sum(int(r["hit_top3"]) for r in rows) / n, 4),
        "recall_at_5": round(sum(int(r["hit_top5"]) for r in rows) / n, 4),
        "image_hit_rate": round(sum(int(r["image_hit"]) for r in rows) / n, 4),
        "avg_quality": avg("quality_score"),
        "avg_confidence": avg("confidence"),
        "avg_timing_ms": avg_timing,
        "low_confidence": [
            {"sample_index": r["sample_index"], "query": r["query"], "confidence": r["confidence"]}
            for r in rows
            if r["confidence"] is not None and float(r["confidence"]) < 0.6
        ][:10],
        "failures": [
            {"sample_index": r["sample_index"], "query": r["query"], "expected": r["expected_item_id"], "actual": r["actual_item_id"]}
            for r in rows
            if not int(r["hit_top5"])
        ][:10],
    }
