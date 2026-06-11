from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def agent_files_dir(agent_id: str) -> str:
    return f"files/agent_{agent_id}"


@dataclass
class AgentsStore:
    path: Path
    _lock: threading.Lock
    _cache: Dict[str, Dict[str, Any]]

    @staticmethod
    def open(path: Path) -> "AgentsStore":
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text("{}", encoding="utf-8")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeError("agents.json 结构必须是 JSON object")
        store = AgentsStore(path=path, _lock=threading.Lock(), _cache=data)
        store._normalize_files_dirs()
        return store

    def _normalize_files_dirs(self) -> None:
        changed = False
        with self._lock:
            for agent_id, cfg in self._cache.items():
                if not isinstance(cfg, dict):
                    continue
                expected = agent_files_dir(agent_id)
                if cfg.get("files_dir") != expected:
                    cfg["files_dir"] = expected
                    changed = True
            if changed:
                self._save()

    def _save(self) -> None:
        # Keep stable formatting for diffs
        self.path.write_text(json.dumps(self._cache, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_all(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {
                agent_id: self._with_files_dir(agent_id, v)
                for agent_id, v in self._cache.items()
                if isinstance(v, dict)
            }

    def get(self, agent_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            cfg = self._cache.get(agent_id)
            return self._with_files_dir(agent_id, cfg) if isinstance(cfg, dict) else None

    @staticmethod
    def _with_files_dir(agent_id: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(cfg)
        out["files_dir"] = agent_files_dir(agent_id)
        return out

    def create_agent(self, *, agent_id: str, name: str) -> Dict[str, Any]:
        with self._lock:
            if agent_id in self._cache:
                raise ValueError("agent_id 已存在")
            cfg: Dict[str, Any] = {
                "name": name,
                "status": "created",
                "knowledge": "",
                "answer_instructions": "",
                "answer_prompt": "",
                "files_dir": f"files/agent_{agent_id}",
                "files": [],
                "route_questions": [],
                "file_summaries": [],
                "last_initialized_at": "",
            }
            self._cache[agent_id] = cfg
            self._save()
            return dict(cfg)

    def next_available_agent_id(self) -> str:
        with self._lock:
            used: set[int] = set()
            for aid in self._cache:
                if str(aid).isdigit():
                    used.add(int(aid))
            n = 1
            while n in used:
                n += 1
            return str(n)

    def delete_agent(self, *, agent_id: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            del self._cache[agent_id]
            self._save()
            return dict(cfg)

    def rename_agent(self, *, agent_id: str, new_agent_id: str) -> Dict[str, Any]:
        new_id = (new_agent_id or "").strip()
        if not new_id:
            raise ValueError("new_agent_id 不能为空")
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            if new_id in self._cache:
                raise ValueError("new_agent_id 已存在")
            cfg = self._cache.pop(agent_id)
            cfg["files_dir"] = agent_files_dir(new_id)
            self._cache[new_id] = cfg
            self._save()
            return self._with_files_dir(new_id, cfg)

    def register_files(self, *, agent_id: str, files: List[str]) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            existing = list(cfg.get("files", [])) if isinstance(cfg.get("files"), list) else []
            for f in files:
                if f not in existing:
                    existing.append(f)
            cfg["files"] = existing
            self._cache[agent_id] = cfg
            self._save()
            return dict(cfg)

    def set_files_dir(self, *, agent_id: str, files_dir: str) -> Dict[str, Any]:
        """files_dir is hard-bound to files/agent_{id}/; custom values are ignored."""
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            cfg["files_dir"] = agent_files_dir(agent_id)
            self._cache[agent_id] = cfg
            self._save()
            return self._with_files_dir(agent_id, cfg)

    def set_knowledge(self, *, agent_id: str, knowledge: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            cfg["knowledge"] = knowledge
            self._cache[agent_id] = cfg
            self._save()
            return dict(cfg)

    def set_answer_instructions(self, *, agent_id: str, answer_instructions: str) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            cfg["answer_instructions"] = answer_instructions
            self._cache[agent_id] = cfg
            self._save()
            return dict(cfg)

    def set_answer_prompt(self, *, agent_id: str, answer_prompt: str) -> Dict[str, Any]:
        """Deprecated: stores into knowledge for backward compatibility."""
        return self.set_knowledge(agent_id=agent_id, knowledge=answer_prompt)

    def set_files(self, *, agent_id: str, files: List[str]) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            cfg["files"] = list(files)
            self._cache[agent_id] = cfg
            self._save()
            return dict(cfg)

    def mark_uninitialized(self, *, agent_id: str) -> Dict[str, Any]:
        """Keep knowledge text but clear routing index; agent must be initialized again."""
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            cfg["status"] = "created"
            cfg["files"] = []
            cfg["route_questions"] = []
            cfg["file_summaries"] = []
            cfg["last_initialized_at"] = ""
            self._cache[agent_id] = cfg
            self._save()
            return dict(cfg)

    def reset_agent_to_created(self, *, agent_id: str) -> Dict[str, Any]:
        """Clear cached knowledge and routing index when folder has no knowledge files."""
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            cfg["status"] = "created"
            cfg["knowledge"] = ""
            cfg["answer_prompt"] = ""
            cfg["files"] = []
            cfg["route_questions"] = []
            cfg["file_summaries"] = []
            cfg["last_initialized_at"] = ""
            self._cache[agent_id] = cfg
            self._save()
            return dict(cfg)

    def update_initialized(
        self,
        *,
        agent_id: str,
        files: List[str],
        route_questions: List[str],
        file_summaries: List[Dict[str, str]],
        when_iso: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            cfg = self._cache.get(agent_id)
            if not isinstance(cfg, dict):
                raise KeyError("agent_id 不存在")
            cfg["status"] = "initialized"
            cfg["files"] = files
            cfg["route_questions"] = route_questions
            cfg["file_summaries"] = file_summaries
            cfg["last_initialized_at"] = when_iso or _now_iso()
            self._cache[agent_id] = cfg
            self._save()
            return dict(cfg)

