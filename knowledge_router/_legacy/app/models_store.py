"""运行时模型配置：config/models.json，支持按槽位独立 API/模型。"""
from __future__ import annotations

import json
import threading
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from .config import Settings

SLOTS = ("match", "import", "pdf_vlm")
MASK = "***"


def parse_enable_thinking(val: Any) -> bool | None:
    """解析 JSON 中的 enable_thinking；缺省或 null 表示沿用 .env 全局设置。"""
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return bool(val)
    if isinstance(val, str):
        s = val.strip().lower()
        if s in {"1", "true", "yes"}:
            return True
        if s in {"0", "false", "no"}:
            return False
    return None


@dataclass
class ModelSlotConfig:
    label: str
    api_base_url: str
    api_key: str
    model: str
    max_tokens: int
    temperature: float
    enable_thinking: bool | None = None

    def to_dict(self, *, mask_key: bool = True) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "label": self.label,
            "api_base_url": self.api_base_url,
            "api_key": MASK if mask_key and self.api_key else self.api_key,
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }
        if self.enable_thinking is not None:
            out["enable_thinking"] = self.enable_thinking
        return out


class ModelsStore:
    """读写 models.json，线程安全。"""

    def __init__(self, path: Path, defaults: Dict[str, ModelSlotConfig]) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._defaults = defaults
        self._slots: Dict[str, ModelSlotConfig] = {}
        self._load_or_seed()

    @staticmethod
    def from_settings(settings: Settings) -> "ModelsStore":
        path = settings.data_root / "config" / "models.json"
        defaults = {
            "match": ModelSlotConfig(
                label="回答模型",
                api_base_url=settings.api_base_url,
                api_key=settings.api_key,
                model=settings.match_model,
                max_tokens=settings.confidence_max_tokens,
                temperature=settings.match_temperature,
            ),
            "import": ModelSlotConfig(
                label="FAQ 生成模型",
                api_base_url=settings.api_base_url,
                api_key=settings.api_key,
                model=settings.import_model,
                max_tokens=settings.max_tokens,
                temperature=0.2,
            ),
            "pdf_vlm": ModelSlotConfig(
                label="文档提取模型",
                api_base_url=settings.api_base_url,
                api_key=settings.api_key,
                model=settings.import_model,
                max_tokens=settings.max_tokens,
                temperature=0.0,
            ),
        }
        return ModelsStore(path, defaults)

    def _load_or_seed(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if not self._path.exists():
            self._slots = deepcopy(self._defaults)
            self._save_unlocked()
            return
        raw = json.loads(self._path.read_text(encoding="utf-8"))
        self._slots = {}
        for slot in SLOTS:
            base = self._defaults[slot]
            row = raw.get(slot, {}) if isinstance(raw, dict) else {}
            if not isinstance(row, dict):
                row = {}
            key = str(row.get("api_key", "")).strip()
            if key == MASK:
                key = ""
            self._slots[slot] = ModelSlotConfig(
                label=str(row.get("label", base.label)),
                api_base_url=str(row.get("api_base_url", base.api_base_url)).strip() or base.api_base_url,
                api_key=key,
                model=str(row.get("model", base.model)).strip() or base.model,
                max_tokens=int(row.get("max_tokens", base.max_tokens)),
                temperature=float(row.get("temperature", base.temperature)),
                enable_thinking=parse_enable_thinking(row.get("enable_thinking", base.enable_thinking)),
            )

    def _save_unlocked(self) -> None:
        payload = {slot: cfg.to_dict(mask_key=False) for slot, cfg in self._slots.items()}
        self._path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_slot(self, slot: str) -> ModelSlotConfig:
        if slot not in SLOTS:
            raise KeyError(f"unknown slot: {slot}")
        with self._lock:
            return self._slots[slot]

    def get_all(self, *, mask_key: bool = True) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return {s: self._slots[s].to_dict(mask_key=mask_key) for s in SLOTS}

    def update_slot(self, slot: str, patch: Dict[str, Any]) -> Dict[str, Any]:
        if slot not in SLOTS:
            raise KeyError(f"unknown slot: {slot}")
        with self._lock:
            cfg = self._slots[slot]
            key_in = patch.get("api_key")
            new_key = cfg.api_key
            if key_in is not None:
                k = str(key_in).strip()
                if k != MASK:
                    new_key = k
            enable_thinking = cfg.enable_thinking
            if "enable_thinking" in patch:
                enable_thinking = parse_enable_thinking(patch.get("enable_thinking"))
            self._slots[slot] = ModelSlotConfig(
                label=str(patch.get("label", cfg.label)),
                api_base_url=str(patch.get("api_base_url", cfg.api_base_url)).strip() or cfg.api_base_url,
                api_key=new_key,
                model=str(patch.get("model", cfg.model)).strip() or cfg.model,
                max_tokens=int(patch.get("max_tokens", cfg.max_tokens)),
                temperature=float(patch.get("temperature", cfg.temperature)),
                enable_thinking=enable_thinking,
            )
            self._save_unlocked()
            return self._slots[slot].to_dict(mask_key=False)

    def update_all(self, body: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        for slot in SLOTS:
            if slot in body and isinstance(body[slot], dict):
                self.update_slot(slot, body[slot])
        return self.get_all(mask_key=False)
