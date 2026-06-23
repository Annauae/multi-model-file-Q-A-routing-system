from __future__ import annotations

import json
import shutil
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class KbStore:
    path: Path
    _lock: threading.Lock
    _cache: Dict[str, Dict[str, Any]]

    @staticmethod
    def open(path: Path) -> "KbStore":
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text("{}", encoding="utf-8")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeError("knowledge_bases.json 结构必须是 JSON object")
        return KbStore(path=path, _lock=threading.Lock(), _cache=data)

    def _save(self) -> None:
        self.path.write_text(json.dumps(self._cache, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_all(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {kid: dict(v) for kid, v in self._cache.items() if isinstance(v, dict)}

    def get(self, kb_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            cfg = self._cache.get(kb_id)
            return dict(cfg) if isinstance(cfg, dict) else None

    def next_available_kb_id(self) -> str:
        with self._lock:
            used: set[int] = set()
            for kid in self._cache:
                if str(kid).isdigit():
                    used.add(int(kid))
            n = 1
            while n in used:
                n += 1
            return str(n)

    def create_kb(self, *, kb_id: str, name: str) -> Dict[str, Any]:
        with self._lock:
            if kb_id in self._cache:
                raise ValueError("kb_id 已存在")
            now = _now_iso()
            cfg: Dict[str, Any] = {
                "name": name,
                "match_prompt": "",
                "status": "ready",
                "created_at": now,
                "updated_at": now,
            }
            self._cache[kb_id] = cfg
            self._save()
            return dict(cfg)

    def delete_kb(self, *, kb_id: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(kb_id)
            if not isinstance(cfg, dict):
                raise KeyError("kb_id 不存在")
            del self._cache[kb_id]
            self._save()
            return dict(cfg)

    def rename_kb(self, *, kb_id: str, name: str) -> Dict[str, Any]:
        new_name = (name or "").strip()
        if not new_name:
            raise ValueError("name 不能为空")
        with self._lock:
            cfg = self._cache.get(kb_id)
            if not isinstance(cfg, dict):
                raise KeyError("kb_id 不存在")
            cfg["name"] = new_name
            cfg["updated_at"] = _now_iso()
            self._cache[kb_id] = cfg
            self._save()
            return dict(cfg)

    def set_match_prompt(self, *, kb_id: str, match_prompt: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(kb_id)
            if not isinstance(cfg, dict):
                raise KeyError("kb_id 不存在")
            cfg["match_prompt"] = match_prompt or ""
            cfg["updated_at"] = _now_iso()
            self._cache[kb_id] = cfg
            self._save()
            return dict(cfg)

    def delete_kb_files(self, *, kb_id: str, files_root: Path) -> None:
        from .paths import kb_dir_path

        target = kb_dir_path(files_root, kb_id)
        if target.exists():
            shutil.rmtree(target)
