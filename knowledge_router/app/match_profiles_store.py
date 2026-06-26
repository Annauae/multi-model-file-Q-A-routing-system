"""多套回答模型配置：config/match_profiles.json。"""
from __future__ import annotations

import json
import threading
import uuid
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .models_store import MASK, ModelSlotConfig, ModelsStore

DEFAULT_PROFILE_ID = "default"


@dataclass
class MatchProfile:
    id: str
    name: str
    api_base_url: str
    api_key: str
    model: str
    max_tokens: int
    temperature: float

    def to_dict(self, *, mask_key: bool = True) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "api_base_url": self.api_base_url,
            "api_key": MASK if mask_key and self.api_key else self.api_key,
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }


class MatchProfilesStore:
    def __init__(self, path: Path, *, seed_from: ModelSlotConfig | None = None) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._seed_from = seed_from
        self._profiles: List[MatchProfile] = []
        self._default_id = DEFAULT_PROFILE_ID
        self._load_or_seed()

    @staticmethod
    def open(path: Path, *, models_store: ModelsStore | None = None) -> "MatchProfilesStore":
        seed = models_store.get_slot("match") if models_store is not None else None
        path.parent.mkdir(parents=True, exist_ok=True)
        return MatchProfilesStore(path, seed_from=seed)

    def _load_or_seed(self) -> None:
        if not self._path.exists():
            cfg = self._seed_from
            self._profiles = [
                MatchProfile(
                    id=DEFAULT_PROFILE_ID,
                    name="默认回答模型",
                    api_base_url=cfg.api_base_url if cfg else "",
                    api_key=cfg.api_key if cfg else "",
                    model=cfg.model if cfg else "",
                    max_tokens=cfg.max_tokens if cfg else 4096,
                    temperature=cfg.temperature if cfg else 0.0,
                )
            ]
            self._default_id = DEFAULT_PROFILE_ID
            self._save_unlocked()
            return
        raw = json.loads(self._path.read_text(encoding="utf-8"))
        rows = raw.get("profiles", []) if isinstance(raw, dict) else []
        self._default_id = str(raw.get("default_id", DEFAULT_PROFILE_ID) if isinstance(raw, dict) else DEFAULT_PROFILE_ID)
        self._profiles = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            pid = str(row.get("id", "")).strip()
            if not pid:
                continue
            key = str(row.get("api_key", "")).strip()
            if key == MASK:
                key = ""
            self._profiles.append(
                MatchProfile(
                    id=pid,
                    name=str(row.get("name", pid)).strip() or pid,
                    api_base_url=str(row.get("api_base_url", "")).strip(),
                    api_key=key,
                    model=str(row.get("model", "")).strip(),
                    max_tokens=int(row.get("max_tokens", 4096)),
                    temperature=float(row.get("temperature", 0)),
                )
            )
        if not self._profiles:
            self._load_or_seed_from_empty()

    def _load_or_seed_from_empty(self) -> None:
        cfg = self._seed_from
        self._profiles = [
            MatchProfile(
                id=DEFAULT_PROFILE_ID,
                name="默认回答模型",
                api_base_url=cfg.api_base_url if cfg else "",
                api_key=cfg.api_key if cfg else "",
                model=cfg.model if cfg else "",
                max_tokens=cfg.max_tokens if cfg else 4096,
                temperature=cfg.temperature if cfg else 0.0,
            )
        ]
        self._default_id = DEFAULT_PROFILE_ID
        self._save_unlocked()

    def _find_unlocked(self, profile_id: str) -> MatchProfile | None:
        pid = (profile_id or "").strip()
        for p in self._profiles:
            if p.id == pid:
                return p
        return None

    def _save_unlocked(self) -> None:
        payload = {
            "default_id": self._default_id,
            "profiles": [p.to_dict(mask_key=False) for p in self._profiles],
        }
        self._path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def list_profiles(self, *, mask_key: bool = True) -> List[Dict[str, Any]]:
        with self._lock:
            return [p.to_dict(mask_key=mask_key) for p in self._profiles]

    def get_default_id(self) -> str:
        with self._lock:
            return self._default_id

    def get(self, profile_id: str = "") -> MatchProfile:
        with self._lock:
            pid = (profile_id or "").strip() or self._default_id
            p = self._find_unlocked(pid)
            if p is None and self._profiles:
                p = self._find_unlocked(self._default_id) or self._profiles[0]
            if p is None:
                raise KeyError(f"match profile not found: {profile_id}")
            return deepcopy(p)

    def update_all(self, body: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            rows = body.get("profiles")
            if isinstance(rows, list):
                updated: List[MatchProfile] = []
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    pid = str(row.get("id", "")).strip() or f"p_{uuid.uuid4().hex[:8]}"
                    old = self._find_unlocked(pid)
                    key_in = row.get("api_key")
                    new_key = old.api_key if old else ""
                    if key_in is not None:
                        k = str(key_in).strip()
                        if k != MASK:
                            new_key = k
                    updated.append(
                        MatchProfile(
                            id=pid,
                            name=str(row.get("name", pid)).strip() or pid,
                            api_base_url=str(row.get("api_base_url", old.api_base_url if old else "")).strip(),
                            api_key=new_key,
                            model=str(row.get("model", old.model if old else "")).strip(),
                            max_tokens=int(row.get("max_tokens", old.max_tokens if old else 4096)),
                            temperature=float(row.get("temperature", old.temperature if old else 0)),
                        )
                    )
                if updated:
                    self._profiles = updated
            if "default_id" in body and str(body.get("default_id", "")).strip():
                self._default_id = str(body["default_id"]).strip()
            self._save_unlocked()
            return {
                "default_id": self._default_id,
                "profiles": [p.to_dict(mask_key=False) for p in self._profiles],
            }
