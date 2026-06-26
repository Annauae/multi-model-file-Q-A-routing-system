"""全局提示词：config/prompts.json，所有知识库共用。"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class GlobalPrompts:
    confidence_match_prompt: str = ""
    faq_generation_prompt: str = ""
    pdf_vlm_prompt: str = ""
    updated_at: str = ""


class PromptsStore:
    """线程安全的全局提示词存储。"""

    def __init__(self, path: Path, *, on_change: Callable[[], None] | None = None) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._on_change = on_change
        self._data = GlobalPrompts()
        self._load_or_seed()

    @staticmethod
    def open(path: Path, *, on_change: Callable[[], None] | None = None) -> "PromptsStore":
        path.parent.mkdir(parents=True, exist_ok=True)
        return PromptsStore(path, on_change=on_change)

    def _load_or_seed(self) -> None:
        if not self._path.exists():
            self._data = GlobalPrompts(updated_at=_now_iso())
            self._save_unlocked()
            return
        raw = json.loads(self._path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
        conf = str(raw.get("confidence_match_prompt", "") or "")
        if not conf and raw.get("match_prompt"):
            conf = ""
        self._data = GlobalPrompts(
            confidence_match_prompt=conf,
            faq_generation_prompt=str(raw.get("faq_generation_prompt", "") or ""),
            pdf_vlm_prompt=str(raw.get("pdf_vlm_prompt", "") or ""),
            updated_at=str(raw.get("updated_at", "") or ""),
        )

    def _save_unlocked(self) -> None:
        payload = {
            "confidence_match_prompt": self._data.confidence_match_prompt,
            "faq_generation_prompt": self._data.faq_generation_prompt,
            "pdf_vlm_prompt": self._data.pdf_vlm_prompt,
            "updated_at": self._data.updated_at,
        }
        self._path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def get(self) -> GlobalPrompts:
        with self._lock:
            return GlobalPrompts(
                confidence_match_prompt=self._data.confidence_match_prompt,
                faq_generation_prompt=self._data.faq_generation_prompt,
                pdf_vlm_prompt=self._data.pdf_vlm_prompt,
                updated_at=self._data.updated_at,
            )

    def set(
        self,
        *,
        confidence_match_prompt: str | None = None,
        faq_generation_prompt: str | None = None,
        pdf_vlm_prompt: str | None = None,
    ) -> GlobalPrompts:
        with self._lock:
            if confidence_match_prompt is not None:
                self._data.confidence_match_prompt = confidence_match_prompt or ""
            if faq_generation_prompt is not None:
                self._data.faq_generation_prompt = faq_generation_prompt or ""
            if pdf_vlm_prompt is not None:
                self._data.pdf_vlm_prompt = pdf_vlm_prompt or ""
            self._data.updated_at = _now_iso()
            self._save_unlocked()
            out = GlobalPrompts(
                confidence_match_prompt=self._data.confidence_match_prompt,
                faq_generation_prompt=self._data.faq_generation_prompt,
                pdf_vlm_prompt=self._data.pdf_vlm_prompt,
                updated_at=self._data.updated_at,
            )
        if self._on_change is not None:
            self._on_change()
        return out

    def effective_confidence_prompt(self) -> str:
        return self.get().confidence_match_prompt.strip()

    def effective_faq_prompt(self) -> str:
        return self.get().faq_generation_prompt.strip()

    def effective_pdf_vlm_prompt(self) -> str:
        return self.get().pdf_vlm_prompt.strip()
