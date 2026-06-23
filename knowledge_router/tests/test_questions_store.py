from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.questions_cache import QuestionsCache
from app.questions_store import QuestionsStore, QuestionsStoreRegistry
from app.schemas import QAItem


@pytest.fixture
def temp_kb(tmp_path: Path):
    files_root = tmp_path / "files"
    kb_id = "9"
    store_registry = QuestionsStoreRegistry(files_root=files_root)
    cache = QuestionsCache(store_registry=store_registry)
    store = store_registry.for_kb(kb_id)
    store.replace_all(
        {
            "version": 1,
            "items": [
                {
                    "id": "q1",
                    "question": "Q1?",
                    "variants": ["v1"],
                    "answer": "A1",
                    "enabled": True,
                },
                {
                    "id": "q2",
                    "question": "Q2?",
                    "variants": [],
                    "answer": "A2",
                    "enabled": False,
                },
            ],
        }
    )
    return kb_id, store_registry, cache


def test_questions_store_crud(temp_kb) -> None:
    kb_id, store_registry, _cache = temp_kb
    store = store_registry.for_kb(kb_id)
    items = store.list_items()
    assert len(items) == 2
    store.upsert_item(
        QAItem(id="q3", question="Q3?", variants=[], answer="A3", enabled=True)
    )
    assert store.get_item("q3") is not None
    removed = store.delete_item("q3")
    assert removed.id == "q3"
    assert store.get_item("q3") is None


def test_questions_store_validates_unique_ids(tmp_path: Path) -> None:
    store = QuestionsStore(path=tmp_path / "q.json", kb_id="1")
    with pytest.raises(ValueError, match="重复"):
        store.replace_all(
            {
                "version": 1,
                "items": [
                    {"id": "a", "question": "1?", "answer": "x"},
                    {"id": "a", "question": "2?", "answer": "y"},
                ],
            }
        )


def test_cache_load_and_lookup(temp_kb) -> None:
    kb_id, _store_registry, cache = temp_kb
    index = cache.load_kb(kb_id)
    assert len(index.enabled_items) == 1
    assert cache.get_item_by_id(kb_id, "q1").answer == "A1"
    candidates = cache.get_enabled_candidates(kb_id)
    assert len(candidates) == 1
    assert candidates[0].id == "q1"


def test_cache_reload_after_write(temp_kb) -> None:
    kb_id, store_registry, cache = temp_kb
    cache.load_kb(kb_id)

    def on_changed(kid: str) -> None:
        cache.reload_kb(kid)

    store_registry._on_changed = on_changed
    store = store_registry.for_kb(kb_id)
    store.upsert_item(
        QAItem(id="q9", question="New?", variants=[], answer="New answer", enabled=True)
    )
    assert cache.get_item_by_id(kb_id, "q9") is not None
    assert cache.enabled_count(kb_id) == 2
