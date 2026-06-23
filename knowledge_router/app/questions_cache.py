from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from .kb_store import KbStore
from .matcher import build_match_system_prompt
from .paths import questions_json_path
from .questions_store import QuestionsStore
from .schemas import QAItem


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class KbMemoryIndex:
    items_by_id: Dict[str, QAItem] = field(default_factory=dict)
    items_by_question: Dict[str, QAItem] = field(default_factory=dict)
    enabled_items: List[QAItem] = field(default_factory=list)
    valid_ids: set[str] = field(default_factory=set)
    match_system_prompt: str = ""
    loaded_at: str = ""
    source_mtime: float = 0.0


class QuestionsCache:
    def __init__(self, *, kb_store: KbStore, files_root: Path):
        self._kb_store = kb_store
        self._files_root = files_root
        self._lock = threading.RLock()
        self._indexes: Dict[str, KbMemoryIndex] = {}
        self._stores: Dict[str, QuestionsStore] = {}

    def _normalize_question(self, question: str) -> str:
        return " ".join((question or "").strip().split())

    def _build_index(self, *, kb_id: str, doc_items: List[QAItem], match_prompt: str) -> KbMemoryIndex:
        items_by_id: Dict[str, QAItem] = {}
        items_by_question: Dict[str, QAItem] = {}
        enabled_items: List[QAItem] = []
        valid_ids: set[str] = set()
        for item in doc_items:
            items_by_id[item.id] = item
            key = self._normalize_question(item.question)
            if key:
                items_by_question[key] = item
            if item.enabled:
                enabled_items.append(item)
                valid_ids.add(item.id)
        system_prompt = build_match_system_prompt(match_prompt=match_prompt, enabled_items=enabled_items)
        return KbMemoryIndex(
            items_by_id=items_by_id,
            items_by_question=items_by_question,
            enabled_items=enabled_items,
            valid_ids=valid_ids,
            match_system_prompt=system_prompt,
            loaded_at=_now_iso(),
            source_mtime=0.0,
        )

    def _store_for(self, kb_id: str) -> QuestionsStore:
        kid = (kb_id or "").strip()
        if kid not in self._stores:
            path = questions_json_path(self._files_root, kid)

            def on_change(changed_kb_id: str) -> None:
                self.reload_kb(changed_kb_id)

            self._stores[kid] = QuestionsStore.open(path, kb_id=kid, on_change=on_change)
        return self._stores[kid]

    def load_kb(self, kb_id: str) -> KbMemoryIndex:
        kid = (kb_id or "").strip()
        cfg = self._kb_store.get(kid)
        if not cfg:
            raise KeyError("kb_id 不存在")
        store = self._store_for(kid)
        doc = store.get_document()
        idx = self._build_index(
            kb_id=kid,
            doc_items=doc.items,
            match_prompt=str(cfg.get("match_prompt") or ""),
        )
        idx.source_mtime = store.source_mtime
        with self._lock:
            self._indexes[kid] = idx
        return idx

    def reload_kb(self, kb_id: str) -> KbMemoryIndex:
        kid = (kb_id or "").strip()
        with self._lock:
            self._stores.pop(kid, None)
        return self.load_kb(kid)

    def evict_kb(self, kb_id: str) -> None:
        kid = (kb_id or "").strip()
        with self._lock:
            self._indexes.pop(kid, None)
            self._stores.pop(kid, None)

    def load_all(self) -> None:
        for kb_id in self._kb_store.get_all():
            try:
                self.load_kb(kb_id)
            except Exception:
                continue

    def get_index(self, kb_id: str) -> Optional[KbMemoryIndex]:
        kid = (kb_id or "").strip()
        with self._lock:
            return self._indexes.get(kid)

    def get_match_system_prompt(self, kb_id: str) -> str:
        idx = self.get_index(kb_id)
        if idx is None:
            idx = self.load_kb(kb_id)
        return idx.match_system_prompt

    def get_enabled_count(self, kb_id: str) -> int:
        idx = self.get_index(kb_id)
        if idx is None:
            idx = self.load_kb(kb_id)
        return len(idx.enabled_items)

    def resolve_item(self, kb_id: str, matched_id: str) -> Optional[QAItem]:
        kid = (kb_id or "").strip()
        iid = (matched_id or "").strip()
        if not iid:
            return None
        idx = self.get_index(kid)
        if idx is None:
            idx = self.load_kb(kid)
        item = idx.items_by_id.get(iid)
        if item is None or not item.enabled:
            return None
        return item

    def get_item_by_id(self, kb_id: str, item_id: str) -> Optional[QAItem]:
        idx = self.get_index(kb_id)
        if idx is None:
            idx = self.load_kb(kb_id)
        return idx.items_by_id.get((item_id or "").strip())

    def store(self, kb_id: str) -> QuestionsStore:
        return self._store_for(kb_id)

    def preview_system_prompt(self, kb_id: str) -> tuple[str, str, int]:
        cfg = self._kb_store.get(kb_id)
        if not cfg:
            raise KeyError("kb_id 不存在")
        match_prompt = str(cfg.get("match_prompt") or "")
        system_prompt = self.get_match_system_prompt(kb_id)
        return match_prompt, system_prompt, self.get_enabled_count(kb_id)
