"""知识库内存索引：预拼 match/confidence system prompt，加速问答查表。

启动时 load_all；questions.json 或 match_prompt 变更时 reload_kb 重建索引。
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from .kb_store import KbStore
from .matcher import build_match_system_prompt, build_confidence_system_prompt
from .paths import questions_json_path
from .questions_store import QuestionsStore
from .schemas import QAItem


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class KbMemoryIndex:
    """单个知识库的运行时索引快照。"""

    items_by_id: Dict[str, QAItem] = field(default_factory=dict)  # id -> 条目
    items_by_question: Dict[str, QAItem] = field(default_factory=dict)  # 归一化标准问题 -> 条目
    enabled_items: List[QAItem] = field(default_factory=list)  # enabled=True 的列表
    valid_ids: set[str] = field(default_factory=set)  # 参与匹配的 id 白名单
    match_system_prompt: str = ""  # 单 id 匹配完整 system prompt（预计算）
    confidence_system_prompt: str = ""  # 默认 top_k 的置信度 system prompt
    loaded_at: str = ""  # 索引构建时间 ISO
    source_mtime: float = 0.0  # questions.json mtime


class QuestionsCache:
    """多知识库索引管理器。"""

    def __init__(self, *, kb_store: KbStore, files_root: Path, confidence_top_k: int = 5):
        self._kb_store = kb_store
        self._files_root = files_root
        self._confidence_top_k = confidence_top_k  # 与 Settings.confidence_top_k 一致
        self._lock = threading.RLock()
        self._indexes: Dict[str, KbMemoryIndex] = {}
        self._stores: Dict[str, QuestionsStore] = {}  # 懒加载 per-kb store

    def _normalize_question(self, question: str) -> str:
        """折叠空白，用于 items_by_question 键。"""
        return " ".join((question or "").strip().split())

    def _build_index(
        self, *, kb_id: str, doc_items: List[QAItem], match_prompt: str, confidence_top_k: int = 5
    ) -> KbMemoryIndex:
        """从 FAQ 列表与 match_prompt 构建内存索引与预拼 prompt。"""
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
        # 置信度默认 prompt 用内置规则（match_prompt=""），与单 id 规则分离
        confidence_prompt = build_confidence_system_prompt(
            match_prompt="",
            enabled_items=enabled_items,
            top_k=confidence_top_k,
        )
        return KbMemoryIndex(
            items_by_id=items_by_id,
            items_by_question=items_by_question,
            enabled_items=enabled_items,
            valid_ids=valid_ids,
            match_system_prompt=system_prompt,
            confidence_system_prompt=confidence_prompt,
            loaded_at=_now_iso(),
            source_mtime=0.0,
        )

    def _store_for(self, kb_id: str) -> QuestionsStore:
        """懒创建 QuestionsStore；保存时自动 reload_kb。"""
        kid = (kb_id or "").strip()
        if kid not in self._stores:
            path = questions_json_path(self._files_root, kid)

            def on_change(changed_kb_id: str) -> None:
                self.reload_kb(changed_kb_id)

            self._stores[kid] = QuestionsStore.open(path, kb_id=kid, on_change=on_change)
        return self._stores[kid]

    def load_kb(self, kb_id: str) -> KbMemoryIndex:
        """加载/重建指定 kb 索引；kb 不存在抛 KeyError。"""
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
            confidence_top_k=self._confidence_top_k,
        )
        idx.source_mtime = store.source_mtime
        with self._lock:
            self._indexes[kid] = idx
        return idx

    def reload_kb(self, kb_id: str) -> KbMemoryIndex:
        """丢弃 store 缓存后重新 load_kb（questions 或 prompt 变更后）。"""
        kid = (kb_id or "").strip()
        with self._lock:
            self._stores.pop(kid, None)
        return self.load_kb(kid)

    def evict_kb(self, kb_id: str) -> None:
        """删除知识库时清除内存索引与 store。"""
        kid = (kb_id or "").strip()
        with self._lock:
            self._indexes.pop(kid, None)
            self._stores.pop(kid, None)

    def load_all(self) -> None:
        """启动时预热所有已注册知识库索引。"""
        for kb_id in self._kb_store.get_all():
            try:
                self.load_kb(kb_id)
            except Exception:
                continue

    def get_index(self, kb_id: str) -> Optional[KbMemoryIndex]:
        """取已加载索引；未加载返回 None（不自动 load）。"""
        kid = (kb_id or "").strip()
        with self._lock:
            return self._indexes.get(kid)

    def get_match_system_prompt(self, kb_id: str) -> str:
        """取单 id 匹配 system prompt；必要时 load_kb。"""
        idx = self.get_index(kb_id)
        if idx is None:
            idx = self.load_kb(kb_id)
        return idx.match_system_prompt

    def get_confidence_system_prompt(self, kb_id: str, *, top_k: int | None = None) -> str:
        """取置信度匹配 system prompt。

        top_k 与默认相同时用缓存；否则按请求 top_k 临时拼接（支持前端可调 Top K）。
        """
        idx = self.get_index(kb_id)
        if idx is None:
            idx = self.load_kb(kb_id)
        if top_k is None or top_k == self._confidence_top_k:
            return idx.confidence_system_prompt
        cfg = self._kb_store.get(kb_id) or {}
        return build_confidence_system_prompt(
            match_prompt=str(cfg.get("confidence_match_prompt") or cfg.get("match_prompt") or ""),
            enabled_items=idx.enabled_items,
            top_k=top_k,
        )

    def get_enabled_count(self, kb_id: str) -> int:
        idx = self.get_index(kb_id)
        if idx is None:
            idx = self.load_kb(kb_id)
        return len(idx.enabled_items)

    def resolve_item(self, kb_id: str, matched_id: str) -> Optional[QAItem]:
        """按匹配 id 取条目；仅 enabled 条目有效。"""
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
        """按 id 取条目（含 disabled）。"""
        idx = self.get_index(kb_id)
        if idx is None:
            idx = self.load_kb(kb_id)
        return idx.items_by_id.get((item_id or "").strip())

    def store(self, kb_id: str) -> QuestionsStore:
        """暴露底层 JSON 存储，供 CRUD API 使用。"""
        return self._store_for(kb_id)

    def preview_system_prompt(self, kb_id: str) -> tuple[str, str, int]:
        """管理页预览：返回 (match_prompt规则, 完整system_prompt, enabled_count)。"""
        cfg = self._kb_store.get(kb_id)
        if not cfg:
            raise KeyError("kb_id 不存在")
        match_prompt = str(cfg.get("match_prompt") or "")
        system_prompt = self.get_match_system_prompt(kb_id)
        return match_prompt, system_prompt, self.get_enabled_count(kb_id)
