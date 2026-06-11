from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _new_item(
    *,
    question: str,
    reference_answer: str,
    knowledge_source: str = "",
) -> Dict[str, Any]:
    now = _now_iso()
    return {
        "id": uuid.uuid4().hex[:12],
        "question": question.strip(),
        "reference_answer": reference_answer.strip(),
        "model_answer": "",
        "accuracy_percent": None,
        "accuracy_reason": "",
        "status": "pending",
        "last_agent_id": "",
        "knowledge_source": (knowledge_source or "").strip(),
        "last_error": "",
        "created_at": now,
        "updated_at": now,
    }


@dataclass
class BatchTestsStore:
    path: Path
    _lock: threading.Lock
    _items: List[Dict[str, Any]]

    @staticmethod
    def open(path: Path) -> "BatchTestsStore":
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(json.dumps({"items": []}, ensure_ascii=False, indent=2), encoding="utf-8")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeError("batch_tests.json 结构必须是 JSON object")
        items = data.get("items", [])
        if not isinstance(items, list):
            raise RuntimeError("batch_tests.json items 必须是数组")
        return BatchTestsStore(path=path, _lock=threading.Lock(), _items=list(items))

    def _save(self) -> None:
        payload = {"items": self._items}
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def list_items(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(x) for x in self._items if isinstance(x, dict)]

    def get(self, item_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            for item in self._items:
                if isinstance(item, dict) and str(item.get("id")) == item_id:
                    return dict(item)
        return None

    def create(self, *, question: str, reference_answer: str) -> Dict[str, Any]:
        q = (question or "").strip()
        r = (reference_answer or "").strip()
        if not q:
            raise ValueError("question 不能为空")
        if not r:
            raise ValueError("reference_answer 不能为空")
        item = _new_item(question=q, reference_answer=r)
        with self._lock:
            self._items.append(item)
            self._save()
        return dict(item)

    def create_many(self, entries: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        created: List[Dict[str, Any]] = []
        with self._lock:
            for entry in entries:
                q = (entry.get("question") or "").strip()
                r = (entry.get("reference_answer") or "").strip()
                if not q or not r:
                    continue
                ks = (entry.get("knowledge_source") or entry.get("source") or "").strip()
                agent_id = str(entry.get("agent_id") or entry.get("last_agent_id") or "").strip()
                if not ks and agent_id:
                    ks = f"files/agent_{agent_id}/knowledge.md"
                item = _new_item(question=q, reference_answer=r, knowledge_source=ks)
                self._items.append(item)
                created.append(dict(item))
            if created:
                self._save()
        return created

    def update(
        self,
        item_id: str,
        *,
        question: Optional[str] = None,
        reference_answer: Optional[str] = None,
        **fields: Any,
    ) -> Dict[str, Any]:
        with self._lock:
            for item in self._items:
                if not isinstance(item, dict) or str(item.get("id")) != item_id:
                    continue
                if question is not None:
                    q = question.strip()
                    if not q:
                        raise ValueError("question 不能为空")
                    item["question"] = q
                if reference_answer is not None:
                    r = reference_answer.strip()
                    if not r:
                        raise ValueError("reference_answer 不能为空")
                    item["reference_answer"] = r
                for key, val in fields.items():
                    item[key] = val
                item["updated_at"] = _now_iso()
                self._save()
                return dict(item)
        raise KeyError(item_id)

    def delete(self, item_id: str) -> Dict[str, Any]:
        with self._lock:
            for idx, item in enumerate(self._items):
                if isinstance(item, dict) and str(item.get("id")) == item_id:
                    removed = dict(item)
                    del self._items[idx]
                    self._save()
                    return removed
        raise KeyError(item_id)
