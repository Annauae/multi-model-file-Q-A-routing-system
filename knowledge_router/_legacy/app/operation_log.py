"""全局操作日志：内存环形缓冲 + 可选 JSONL 持久化。"""
from __future__ import annotations

import json
import threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Iterator, List, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class OperationLog:
    """线程安全操作日志存储。"""

    _MAX_DETAIL_LEN = 800

    def __init__(self, *, max_entries: int = 5000, persist_path: Optional[Path] = None) -> None:
        self._lock = threading.Lock()
        self._entries: Deque[Dict[str, Any]] = deque(maxlen=max_entries)
        self._persist_path = persist_path
        if self._persist_path:
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)
            self._load_persisted()

    def _load_persisted(self) -> None:
        if not self._persist_path or not self._persist_path.exists():
            return
        try:
            raw = self._persist_path.read_text(encoding="utf-8")
        except OSError:
            return
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                self._entries.append(entry)

    @classmethod
    def _normalize_detail(cls, detail: str) -> str:
        text = detail or ""
        if len(text) <= cls._MAX_DETAIL_LEN:
            return text
        return f"{text[: cls._MAX_DETAIL_LEN]}…（已截断，共 {len(text)} 字符）"

    def append(
        self,
        *,
        level: str = "info",
        module: str = "system",
        action: str = "",
        kb_id: str = "",
        detail: str = "",
        kind: str = "log",
        extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        entry: Dict[str, Any] = {
            "ts": _now_iso(),
            "level": level,
            "module": module,
            "action": action,
            "kb_id": kb_id or "",
            "detail": self._normalize_detail(detail),
            "kind": kind,
        }
        if extra:
            entry["extra"] = extra
        with self._lock:
            self._entries.append(entry)
            if self._persist_path:
                with self._persist_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return entry

    def list_entries(
        self,
        *,
        limit: int = 500,
        module: str = "",
        kb_id: str = "",
        level: str = "",
    ) -> List[Dict[str, Any]]:
        limit = max(1, min(5000, limit))
        with self._lock:
            items = list(self._entries)
        if module:
            items = [e for e in items if e.get("module") == module]
        if kb_id:
            items = [e for e in items if e.get("kb_id") == kb_id]
        if level:
            items = [e for e in items if e.get("level") == level]
        return items[-limit:]

    def clear(self) -> int:
        with self._lock:
            n = len(self._entries)
            self._entries.clear()
            if self._persist_path and self._persist_path.exists():
                try:
                    self._persist_path.write_text("", encoding="utf-8")
                except OSError:
                    pass
            return n

    def subscribe_since(self, since_ts: str = "") -> Iterator[Dict[str, Any]]:
        """SSE 用：返回 since_ts 之后的新条目（轮询由调用方实现）。"""
        with self._lock:
            items = list(self._entries)
        if since_ts:
            items = [e for e in items if e.get("ts", "") > since_ts]
        yield from items
