"""
questions_cache.py — FAQ 运行时内存索引（/ask 热路径零读盘）

职责：
  启动时 load_all() 将各 kb 的 questions.json 载入内存，构建：
    - items_by_id：O(1) 按 matched_id 取 answer
    - match_candidates：enabled 条目的 {id, question, variants}，送匹配模型
  写操作后由 questions_store 的 on_changed → reload_kb 保持与磁盘一致。

阅读顺序：第 6 个（与 questions_store 成对；理解 /ask 为何不读盘）
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

from .questions_store import QuestionsStoreRegistry
from .schemas import MatchCandidate, QAItem


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class KbMemoryIndex:
    """
    单个知识库在内存中的索引快照。
    一次 load_kb 构建完整索引，/ask 只读此结构。
    """

    items_by_id: Dict[str, QAItem] = field(default_factory=dict)
    enabled_items: List[QAItem] = field(default_factory=list)
    match_candidates: List[MatchCandidate] = field(default_factory=list)
    loaded_at: str = ""           # 本次载入的 ISO 时间
    source_mtime: float = 0.0     # 磁盘 questions.json 的 mtime


def _build_index(doc_items: List[QAItem], *, source_mtime: float) -> KbMemoryIndex:
    """从 FAQ 列表构建三套索引：全量 id 表、启用列表、匹配候选。"""
    items_by_id: Dict[str, QAItem] = {}
    enabled_items: List[QAItem] = []
    match_candidates: List[MatchCandidate] = []
    for item in doc_items:
        items_by_id[item.id] = item
        if not item.enabled:
            continue
        enabled_items.append(item)
        match_candidates.append(
            MatchCandidate(
                id=item.id,
                question=item.question,
                variants=list(item.variants or []),
            )
        )
    return KbMemoryIndex(
        items_by_id=items_by_id,
        enabled_items=enabled_items,
        match_candidates=match_candidates,
        loaded_at=_now_iso(),
        source_mtime=source_mtime,
    )


class QuestionsCache:
    """全局 FAQ 内存缓存；注册在 app.state.questions_cache。"""

    def __init__(self, *, store_registry: QuestionsStoreRegistry):
        self._store_registry = store_registry
        self._lock = threading.RLock()
        self._indexes: Dict[str, KbMemoryIndex] = {}

    def load_kb(self, kb_id: str) -> KbMemoryIndex:
        """从磁盘读 questions.json 并重建该 kb 的内存索引。"""
        kid = (kb_id or "").strip()
        store = self._store_registry.for_kb(kid)
        doc = store.load_document()
        index = _build_index(doc.items, source_mtime=store.source_mtime())
        with self._lock:
            self._indexes[kid] = index
        return index

    def reload_kb(self, kb_id: str) -> KbMemoryIndex:
        """写后刷新：与 load_kb 相同，语义上表示「重新从磁盘加载」。"""
        return self.load_kb(kb_id)

    def evict_kb(self, kb_id: str) -> None:
        """删除知识库时清内存索引并 evict store。"""
        kid = (kb_id or "").strip()
        with self._lock:
            self._indexes.pop(kid, None)
        self._store_registry.evict(kid)

    def load_all(self, kb_ids: List[str]) -> None:
        """FastAPI lifespan 启动时：遍历 knowledge_bases.json 中所有 kb_id。"""
        for kid in kb_ids:
            self.load_kb(kid)

    def get_index(self, kb_id: str) -> Optional[KbMemoryIndex]:
        with self._lock:
            return self._indexes.get(kb_id)

    def get_enabled_candidates(self, kb_id: str) -> List[MatchCandidate]:
        """
        /ask 第一步：取参与语义匹配的候选列表（仅 id/question/variants，不含 answer）。
        若尚未 load，会触发 load_kb。
        """
        index = self.get_index(kb_id)
        if index is None:
            index = self.load_kb(kb_id)
        return list(index.match_candidates)

    def get_item_by_id(self, kb_id: str, item_id: str) -> Optional[QAItem]:
        """
        /ask 第二步：匹配模型返回 matched_id 后，O(1) 取预存 answer。
        """
        index = self.get_index(kb_id)
        if index is None:
            index = self.load_kb(kb_id)
        return index.items_by_id.get((item_id or "").strip())

    def get_document_snapshot(self, kb_id: str) -> tuple[List[QAItem], str, float]:
        """GET questions API：返回内存快照 + loaded_at + mtime。"""
        index = self.get_index(kb_id)
        if index is None:
            index = self.load_kb(kb_id)
        items = list(index.items_by_id.values())
        return items, index.loaded_at, index.source_mtime

    def enabled_count(self, kb_id: str) -> int:
        index = self.get_index(kb_id)
        if not index:
            return 0
        return len(index.enabled_items)

    def item_count(self, kb_id: str) -> int:
        index = self.get_index(kb_id)
        if not index:
            return 0
        return len(index.items_by_id)
