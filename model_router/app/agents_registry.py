from __future__ import annotations

import json
import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .agents_store import AgentsStore
from .config import Settings
from .paths import agents_config_path, router_folder_name


@dataclass
class AgentsStoreRegistry:
    settings: Settings
    _stores: Dict[str, AgentsStore] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def path_for(self, router_id: str) -> Path:
        return agents_config_path(self.settings.files_root, router_id)

    def for_router(self, router_id: str) -> AgentsStore:
        rid = (router_id or "").strip()
        if not rid:
            raise ValueError("router_id 不能为空")
        with self._lock:
            if rid not in self._stores:
                path = self.path_for(rid)
                path.parent.mkdir(parents=True, exist_ok=True)
                if not path.exists():
                    self._bootstrap_router_agents(rid, path)
                self._stores[rid] = AgentsStore.open(path, router_id=rid)
            return self._stores[rid]

    def _bootstrap_router_agents(self, router_id: str, path: Path) -> None:
        """Create empty agents.json, or import legacy global config for router 1."""
        legacy = self.settings.agents_config_path
        if router_id == "1" and legacy.is_file():
            try:
                data = json.loads(legacy.read_text(encoding="utf-8"))
            except Exception:
                data = {}
            if isinstance(data, dict) and data:
                path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                return
        path.write_text("{}", encoding="utf-8")

    def invalidate(self, router_id: str) -> None:
        with self._lock:
            self._stores.pop((router_id or "").strip(), None)

    def get_agents_for_router(self, router_id: str) -> Dict[str, Dict[str, Any]]:
        return self.for_router(router_id).get_all()

    def find_agent(self, agent_id: str) -> Optional[Tuple[str, AgentsStore, Dict[str, Any]]]:
        """Locate agent across all known router stores."""
        aid = (agent_id or "").strip()
        if not aid:
            return None
        routers_dir = self.settings.files_root / "router_"
        if self.settings.files_root.is_dir():
            for entry in sorted(self.settings.files_root.iterdir()):
                if not entry.is_dir() or not entry.name.startswith("router_"):
                    continue
                rid = entry.name.replace("router_", "", 1)
                if not rid:
                    continue
                cfg_path = entry / "agents.json"
                if not cfg_path.is_file():
                    continue
                store = self.for_router(rid)
                cfg = store.get(aid)
                if cfg:
                    return rid, store, cfg
        _ = routers_dir  # silence unused in edge envs
        return None

    def ensure_router_tree(self, router_id: str) -> Path:
        router_dir = (self.settings.files_root / router_folder_name(router_id)).resolve()
        router_dir.mkdir(parents=True, exist_ok=True)
        cfg = self.path_for(router_id)
        if not cfg.exists():
            cfg.write_text("{}", encoding="utf-8")
        return router_dir

    def delete_router_tree(self, router_id: str) -> None:
        self.invalidate(router_id)
        router_dir = (self.settings.files_root / router_folder_name(router_id)).resolve()
        if router_dir.exists():
            shutil.rmtree(router_dir)
