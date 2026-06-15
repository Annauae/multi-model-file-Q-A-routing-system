from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def router_files_dir(router_id: str) -> str:
    return f"files/router_{router_id}"


@dataclass
class RoutersStore:
    path: Path
    _lock: threading.Lock
    _cache: Dict[str, Dict[str, Any]]

    @staticmethod
    def open(path: Path) -> "RoutersStore":
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text("{}", encoding="utf-8")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeError("routers.json 结构必须是 JSON object")
        return RoutersStore(path=path, _lock=threading.Lock(), _cache=data)

    def _save(self) -> None:
        self.path.write_text(json.dumps(self._cache, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_all(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {rid: dict(v) for rid, v in self._cache.items() if isinstance(v, dict)}

    def get(self, router_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            cfg = self._cache.get(router_id)
            return dict(cfg) if isinstance(cfg, dict) else None

    def next_available_router_id(self) -> str:
        with self._lock:
            used: set[int] = set()
            for rid in self._cache:
                if str(rid).isdigit():
                    used.add(int(rid))
            n = 1
            while n in used:
                n += 1
            return str(n)

    def create_router(self, *, router_id: str, name: str) -> Dict[str, Any]:
        with self._lock:
            if router_id in self._cache:
                raise ValueError("router_id 已存在")
            now = _now_iso()
            cfg: Dict[str, Any] = {
                "name": name,
                "router_prompt": "",
                "status": "initialized",
                "agent_ids": [],
                "source_files": [],
                "split_ranges": [],
                "created_at": now,
                "updated_at": now,
            }
            self._cache[router_id] = cfg
            self._save()
            return dict(cfg)

    def delete_router(self, *, router_id: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(router_id)
            if not isinstance(cfg, dict):
                raise KeyError("router_id 不存在")
            del self._cache[router_id]
            self._save()
            return dict(cfg)

    def rename_router(self, *, router_id: str, name: str) -> Dict[str, Any]:
        new_name = (name or "").strip()
        if not new_name:
            raise ValueError("name 不能为空")
        with self._lock:
            cfg = self._cache.get(router_id)
            if not isinstance(cfg, dict):
                raise KeyError("router_id 不存在")
            cfg["name"] = new_name
            cfg["updated_at"] = _now_iso()
            self._cache[router_id] = cfg
            self._save()
            return dict(cfg)

    def set_prompt(self, *, router_id: str, router_prompt: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(router_id)
            if not isinstance(cfg, dict):
                raise KeyError("router_id 不存在")
            cfg["router_prompt"] = router_prompt or ""
            cfg["updated_at"] = _now_iso()
            self._cache[router_id] = cfg
            self._save()
            return dict(cfg)

    def set_split_ranges(self, *, router_id: str, split_ranges: List[List[int]]) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(router_id)
            if not isinstance(cfg, dict):
                raise KeyError("router_id 不存在")
            cfg["split_ranges"] = split_ranges
            cfg["updated_at"] = _now_iso()
            self._cache[router_id] = cfg
            self._save()
            return dict(cfg)

    def add_source_file(self, *, router_id: str, file_path: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(router_id)
            if not isinstance(cfg, dict):
                raise KeyError("router_id 不存在")
            existing = list(cfg.get("source_files", [])) if isinstance(cfg.get("source_files"), list) else []
            if file_path not in existing:
                existing.append(file_path)
            cfg["source_files"] = existing
            cfg["updated_at"] = _now_iso()
            self._cache[router_id] = cfg
            self._save()
            return dict(cfg)

    def assign_agent(self, *, router_id: str, agent_id: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(router_id)
            if not isinstance(cfg, dict):
                raise KeyError("router_id 不存在")
            ids = list(cfg.get("agent_ids", [])) if isinstance(cfg.get("agent_ids"), list) else []
            if agent_id not in ids:
                ids.append(agent_id)
            cfg["agent_ids"] = ids
            cfg["updated_at"] = _now_iso()
            self._cache[router_id] = cfg
            self._save()
            return dict(cfg)

    def unassign_agent(self, *, router_id: str, agent_id: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(router_id)
            if not isinstance(cfg, dict):
                raise KeyError("router_id 不存在")
            ids = list(cfg.get("agent_ids", [])) if isinstance(cfg.get("agent_ids"), list) else []
            cfg["agent_ids"] = [x for x in ids if x != agent_id]
            cfg["updated_at"] = _now_iso()
            self._cache[router_id] = cfg
            self._save()
            return dict(cfg)
