from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings, settings
from .media import ImageRef, extract_image_refs
from .text_utils import answer_summary, stable_hash, strip_markdown


@dataclass(frozen=True)
class FaqItem:
    id: str
    question: str
    variants: list[str]
    answer: str
    enabled: bool
    updated_at: str
    answer_text: str
    answer_summary: str
    images: list[ImageRef]


def _as_str(value: Any, field: str, item_id: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{item_id}: `{field}` must be a non-empty string")
    return value.strip()


def _parse_item(raw: dict[str, Any], cfg: Settings) -> FaqItem:
    item_id = _as_str(raw.get("id"), "id", "<unknown>")
    variants_raw = raw.get("variants")
    if not isinstance(variants_raw, list):
        raise ValueError(f"{item_id}: `variants` must be a list")
    variants = [str(v).strip() for v in variants_raw if str(v).strip()]
    answer = _as_str(raw.get("answer"), "answer", item_id)
    return FaqItem(
        id=item_id,
        question=_as_str(raw.get("question"), "question", item_id),
        variants=variants,
        answer=answer,
        enabled=bool(raw.get("enabled", False)),
        updated_at=_as_str(raw.get("updated_at"), "updated_at", item_id),
        answer_text=strip_markdown(answer),
        answer_summary=answer_summary(answer),
        images=extract_image_refs(answer, cfg),
    )


def load_faq_items(cfg: Settings = settings, *, include_disabled: bool = False) -> list[FaqItem]:
    data = json.loads(Path(cfg.data_path).read_text(encoding="utf-8"))
    items_raw = data.get("items")
    if not isinstance(items_raw, list):
        raise ValueError("questions.json must contain an `items` list")
    items = [_parse_item(raw, cfg) for raw in items_raw if isinstance(raw, dict)]
    if not include_disabled:
        items = [item for item in items if item.enabled]
    return items


def data_hash(cfg: Settings = settings) -> str:
    return stable_hash(Path(cfg.data_path).read_text(encoding="utf-8"))
