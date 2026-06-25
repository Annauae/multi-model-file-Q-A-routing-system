"""单知识库 FAQ 持久化：读写 files/kb_*/questions.json。

线程安全；变更时可通过 on_change 回调触发 QuestionsCache.reload_kb。
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .schemas import QAItem, QuestionsDocument


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _empty_document() -> Dict[str, Any]:
    """新建知识库时的空 questions.json 结构。"""
    return {"version": 1, "items": []}


def _validate_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """校验并规范化 items 数组：id 唯一、question/answer 非空。"""
    seen: set[str] = set()
    out: List[Dict[str, Any]] = []
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError("items 元素必须是 object")
        item_id = str(raw.get("id", "")).strip()
        question = str(raw.get("question", "")).strip()
        answer = str(raw.get("answer", "")).strip()
        if not item_id:
            raise ValueError("id 不能为空")
        if item_id in seen:
            raise ValueError(f"id 重复: {item_id}")
        if not question:
            raise ValueError(f"question 不能为空: {item_id}")
        if not answer:
            raise ValueError(f"answer 不能为空: {item_id}")
        seen.add(item_id)
        variants = raw.get("variants", [])
        if not isinstance(variants, list):
            variants = []
        variants = [str(v).strip() for v in variants if str(v).strip()]
        enabled = raw.get("enabled", True)
        if not isinstance(enabled, bool):
            enabled = True
        updated_at = str(raw.get("updated_at", "")).strip() or _now_iso()
        out.append(
            {
                "id": item_id,
                "question": question,
                "variants": variants,
                "answer": answer,
                "enabled": enabled,
                "updated_at": updated_at,
            }
        )
    return out


@dataclass
class QuestionsStore:
    """单个 kb 的 questions.json 读写器。"""

    path: Path
    kb_id: str
    _lock: threading.Lock
    _cache: Dict[str, Any]  # 内存中的整份 JSON document
    _on_change: Optional[Callable[[str], None]] = None  # 保存后通知，参数为 kb_id

    @staticmethod
    def open(path: Path, *, kb_id: str, on_change: Optional[Callable[[str], None]] = None) -> "QuestionsStore":
        """打开 JSON 文件；不存在则创建空文档。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(json.dumps(_empty_document(), ensure_ascii=False, indent=2), encoding="utf-8")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeError("questions.json 结构必须是 JSON object")
        return QuestionsStore(
            path=path,
            kb_id=(kb_id or "").strip(),
            _lock=threading.Lock(),
            _cache=data,
            _on_change=on_change,
        )

    def _save(self) -> None:
        """写盘并触发 on_change（用于重建内存索引）。"""
        self.path.write_text(json.dumps(self._cache, ensure_ascii=False, indent=2), encoding="utf-8")
        if self._on_change:
            self._on_change(self.kb_id)

    def get_document(self) -> QuestionsDocument:
        """返回 Pydantic 文档对象。"""
        with self._lock:
            version = int(self._cache.get("version", 1) or 1)
            items_raw = self._cache.get("items", [])
            if not isinstance(items_raw, list):
                items_raw = []
            items = [QAItem.model_validate(x) for x in items_raw if isinstance(x, dict)]
            return QuestionsDocument(version=version, items=items)

    def replace_all(self, *, version: int, items: List[Dict[str, Any]]) -> QuestionsDocument:
        """整库替换 items（管理页 JSON 全量保存）。"""
        validated = _validate_items(items)
        with self._lock:
            self._cache = {"version": max(1, version), "items": validated}
            self._save()
        return self.get_document()

    def list_items(self) -> List[QAItem]:
        return self.get_document().items

    def get_item(self, item_id: str) -> Optional[QAItem]:
        """按 id 查找单条；不存在返回 None。"""
        iid = (item_id or "").strip()
        for item in self.list_items():
            if item.id == iid:
                return item
        return None

    def upsert_item(self, *, item: Dict[str, Any]) -> QAItem:
        """新增或按 id 覆盖单条；自动刷新 updated_at。"""
        validated = _validate_items([item])[0]
        validated["updated_at"] = _now_iso()
        with self._lock:
            items = self._cache.get("items", [])
            if not isinstance(items, list):
                items = []
            replaced = False
            new_items: List[Dict[str, Any]] = []
            for raw in items:
                if isinstance(raw, dict) and str(raw.get("id", "")).strip() == validated["id"]:
                    new_items.append(validated)
                    replaced = True
                elif isinstance(raw, dict):
                    new_items.append(raw)
            if not replaced:
                new_items.append(validated)
            self._cache["items"] = new_items
            self._save()
        result = self.get_item(validated["id"])
        assert result is not None
        return result

    def delete_item(self, *, item_id: str) -> QAItem:
        """删除单条；不存在抛 KeyError。"""
        iid = (item_id or "").strip()
        deleted: Optional[Dict[str, Any]] = None
        with self._lock:
            items = self._cache.get("items", [])
            if not isinstance(items, list):
                items = []
            kept: List[Dict[str, Any]] = []
            for raw in items:
                if isinstance(raw, dict) and str(raw.get("id", "")).strip() == iid:
                    deleted = raw
                elif isinstance(raw, dict):
                    kept.append(raw)
            if deleted is None:
                raise KeyError("item_id 不存在")
            self._cache["items"] = kept
            self._save()
        return QAItem.model_validate(deleted)

    @property
    def source_mtime(self) -> float:
        """文件修改时间，用于检测外部变更。"""
        try:
            return self.path.stat().st_mtime
        except OSError:
            return 0.0
