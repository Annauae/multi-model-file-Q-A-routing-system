from __future__ import annotations

import json
from pathlib import Path

import pytest

from knowledge_router.app.kb_store import KbStore
from knowledge_router.app.questions_cache import QuestionsCache
from knowledge_router.app.questions_store import QuestionsStore


@pytest.fixture
def kb_env(tmp_path: Path):
    config_path = tmp_path / "config" / "knowledge_bases.json"
    files_root = tmp_path / "files"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(
            {
                "1": {
                    "name": "测试库",
                    "match_prompt": "",
                    "status": "ready",
                    "created_at": "2026-06-23T00:00:00Z",
                    "updated_at": "2026-06-23T00:00:00Z",
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    qdir = files_root / "kb_1"
    qdir.mkdir(parents=True)
    (qdir / "questions.json").write_text(
        json.dumps(
            {
                "version": 1,
                "items": [
                    {
                        "id": "q001",
                        "question": "测试问题？",
                        "variants": [],
                        "answer": "测试回答",
                        "enabled": True,
                        "updated_at": "2026-06-23T00:00:00Z",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    kb_store = KbStore.open(config_path)
    cache = QuestionsCache(kb_store=kb_store, files_root=files_root)
    cache.load_all()
    return kb_store, cache, files_root


def test_questions_store_crud(kb_env) -> None:
    _, cache, files_root = kb_env
    store = QuestionsStore.open(files_root / "kb_1" / "questions.json", kb_id="1")
    assert store.get_item("q001") is not None
    store.upsert_item(
        item={
            "id": "q002",
            "question": "新问题？",
            "variants": [],
            "answer": "新回答",
            "enabled": True,
        }
    )
    assert store.get_item("q002") is not None
    store.delete_item(item_id="q002")
    assert store.get_item("q002") is None


def test_cache_resolve_item(kb_env) -> None:
    _, cache, _ = kb_env
    item = cache.resolve_item("1", "q001")
    assert item is not None
    assert item.answer == "测试回答"


def test_cache_reload_after_upsert(kb_env) -> None:
    _, cache, files_root = kb_env
    store = QuestionsStore.open(files_root / "kb_1" / "questions.json", kb_id="1", on_change=cache.reload_kb)
    store.upsert_item(
        item={
            "id": "q002",
            "question": "另一个问题？",
            "variants": [],
            "answer": "另一个回答",
            "enabled": True,
        }
    )
    item = cache.resolve_item("1", "q002")
    assert item is not None
    assert "q002|" in cache.get_confidence_system_prompt("1")


def test_cache_evict(kb_env) -> None:
    _, cache, _ = kb_env
    cache.evict_kb("1")
    assert cache.get_index("1") is None
