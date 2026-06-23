"""
questions_store.py — FAQ 磁盘持久化（files/kb_{id}/questions.json）

职责：
  - 唯一合法的 questions.json 写入口（write-through）
  - CRUD：replace_all / upsert_item / delete_item
  - 校验：id 唯一、question/answer 非空
  - 写成功后通过 on_changed 回调触发 QuestionsCache.reload_kb

QuestionsStoreRegistry：
  按 kb_id 懒加载 QuestionsStore 实例，避免一次性打开所有文件。

阅读顺序：第 5 个（磁盘层；与 questions_cache 成对阅读）
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .schemas import QAItem, QuestionsDocument


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _empty_document() -> Dict[str, Any]:
    """新建知识库时的空 FAQ 文件结构。"""
    return {"version": 1, "items": []}


def _validate_document(data: Any) -> QuestionsDocument:
    """解析并校验 JSON；id 重复或必填字段缺失时抛 ValueError。"""
    if not isinstance(data, dict):
        raise ValueError("questions.json 必须是 JSON object")
    doc = QuestionsDocument.model_validate(data)
    seen: set[str] = set()
    for item in doc.items:
        iid = (item.id or "").strip()
        if not iid:
            raise ValueError("item.id 不能为空")
        if iid in seen:
            raise ValueError(f"重复的 item id: {iid}")
        seen.add(iid)
        if not (item.question or "").strip():
            raise ValueError(f"item {iid} 的 question 不能为空")
        if not (item.answer or "").strip():
            raise ValueError(f"item {iid} 的 answer 不能为空")
    return doc


class QuestionsStore:
    """
    单个知识库的 questions.json 读写器。
    每次 _write_doc 成功后调用 on_changed(kb_id) 刷新内存缓存。
    """

    def __init__(self, *, path: Path, kb_id: str, on_changed: Optional[Callable[[str], None]] = None):
        self.path = path
        self.kb_id = (kb_id or "").strip()
        self._lock = threading.RLock()
        self._on_changed = on_changed
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(json.dumps(_empty_document(), ensure_ascii=False, indent=2), encoding="utf-8")

    def _notify(self) -> None:
        """通知 QuestionsCache 该 kb 的数据已在磁盘更新。"""
        if self._on_changed:
            self._on_changed(self.kb_id)

    def _read_raw(self) -> Dict[str, Any]:
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _write_doc(self, doc: QuestionsDocument) -> QuestionsDocument:
        """序列化写入磁盘并触发 cache reload。"""
        payload = doc.model_dump(mode="json")
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._notify()
        return doc

    def load_document(self) -> QuestionsDocument:
        """从磁盘读取并校验（load_kb / reload_kb 时使用）。"""
        with self._lock:
            return _validate_document(self._read_raw())

    def replace_all(self, data: Any) -> QuestionsDocument:
        """整文件覆盖（管理页 JSON 源码 Tab 保存）。"""
        with self._lock:
            doc = _validate_document(data)
            now = _now_iso()
            items: List[QAItem] = []
            for item in doc.items:
                d = item.model_copy()
                if not d.updated_at:
                    d.updated_at = now
                items.append(d)
            doc = QuestionsDocument(version=doc.version or 1, items=items)
            return self._write_doc(doc)

    def list_items(self) -> List[QAItem]:
        return self.load_document().items

    def get_item(self, item_id: str) -> Optional[QAItem]:
        iid = (item_id or "").strip()
        for item in self.list_items():
            if item.id == iid:
                return item
        return None

    def upsert_item(self, item: QAItem) -> QAItem:
        """按 id 新增或更新单条 FAQ。"""
        with self._lock:
            doc = self.load_document()
            now = _now_iso()
            incoming = item.model_copy(update={"updated_at": now})
            replaced = False
            new_items: List[QAItem] = []
            for existing in doc.items:
                if existing.id == incoming.id:
                    new_items.append(incoming)
                    replaced = True
                else:
                    new_items.append(existing)
            if not replaced:
                new_items.append(incoming)
            self._write_doc(QuestionsDocument(version=doc.version, items=new_items))
            return incoming

    def delete_item(self, item_id: str) -> QAItem:
        """删除单条 FAQ，返回被删条目。"""
        iid = (item_id or "").strip()
        with self._lock:
            doc = self.load_document()
            removed: Optional[QAItem] = None
            kept: List[QAItem] = []
            for item in doc.items:
                if item.id == iid:
                    removed = item
                else:
                    kept.append(item)
            if removed is None:
                raise KeyError("item_id 不存在")
            self._write_doc(QuestionsDocument(version=doc.version, items=kept))
            return removed

    def source_mtime(self) -> float:
        """questions.json 文件修改时间（调试/展示用）。"""
        try:
            return self.path.stat().st_mtime
        except OSError:
            return 0.0


class QuestionsStoreRegistry:
    """按 kb_id 管理 QuestionsStore 实例的生命周期。"""

    def __init__(
        self,
        *,
        files_root: Path,
        on_changed: Optional[Callable[[str], None]] = None,
    ):
        self.files_root = files_root
        self._on_changed = on_changed
        self._stores: Dict[str, QuestionsStore] = {}
        self._lock = threading.Lock()

    def _notify_changed(self, kb_id: str) -> None:
        if self._on_changed:
            self._on_changed(kb_id)

    def for_kb(self, kb_id: str) -> QuestionsStore:
        """获取或创建该 kb 的 store；路径由 paths.questions_file_path 决定。"""
        kid = (kb_id or "").strip()
        with self._lock:
            if kid not in self._stores:
                from .paths import questions_file_path

                path = questions_file_path(self.files_root, kid)
                self._stores[kid] = QuestionsStore(
                    path=path, kb_id=kid, on_changed=self._notify_changed
                )
            return self._stores[kid]

    def evict(self, kb_id: str) -> None:
        """删除知识库时从 registry 移除 store 实例。"""
        kid = (kb_id or "").strip()
        with self._lock:
            self._stores.pop(kid, None)
