from __future__ import annotations

import json
import re
from typing import Any, Iterable, List, Set

from .schemas import MatchResult, QAItem

DEFAULT_MATCH_PROMPT_ZH = """你是问题匹配器，不是回答器。
根据用户问题，从【标准问题列表】中选出语义最接近的一项。
列表中同一 id 可能出现多行（标准问题 + 变体问法），命中任意一行都输出该 id。
只输出该项的 id（如 q001）；无法匹配则只输出 NONE。
不要输出任何其他字符、标点、换行或解释。"""

DEFAULT_CONFIDENCE_MATCH_PROMPT_ZH = """你是问题匹配器，不是回答器。
根据用户问题，从【标准问题列表】中找出语义最接近的若干项（最多 {top_k} 项）。
列表中同一 id 可能出现多行（标准问题 + 变体问法），命中任意一行都计入该 id。

只输出 JSON 数组，按 confidence 从高到低排列，每项格式：{{"id":"q001","confidence":0.95}}
confidence 为 0~1 之间的小数，表示匹配置信度；同一 id 只出现一次。
若无任何可匹配项，输出 []。
不要输出任何其他字符、markdown 代码块或解释。"""

NONE_SENTINEL = "NONE"


def default_match_prompt() -> str:
    return DEFAULT_MATCH_PROMPT_ZH


def default_confidence_match_prompt(*, top_k: int = 5) -> str:
    return DEFAULT_CONFIDENCE_MATCH_PROMPT_ZH.format(top_k=top_k)


def default_clarification_question() -> str:
    return "未能匹配到合适的标准问题，请换一种问法或补充更具体的功能名称。"


def iter_question_prompt_lines(item: QAItem) -> List[str]:
    """Scheme A: standard question + each variant as separate lines sharing the same id."""
    lines = [f"{item.id}|{item.question}"]
    seen = {item.question.strip()}
    for variant in item.variants or []:
        v = (variant or "").strip()
        if not v or v in seen:
            continue
        seen.add(v)
        lines.append(f"{item.id}|{v}")
    return lines


def build_question_list_section(enabled_items: Iterable[QAItem]) -> str:
    lines = ["【标准问题列表】"]
    for item in enabled_items:
        lines.extend(iter_question_prompt_lines(item))
    if len(lines) == 1:
        lines.append("(empty)")
    return "\n".join(lines)


def count_question_prompt_lines(enabled_items: Iterable[QAItem]) -> int:
    total = 0
    for item in enabled_items:
        if not item.enabled:
            continue
        total += len(iter_question_prompt_lines(item))
    return total


def build_match_system_prompt(*, match_prompt: str, enabled_items: List[QAItem]) -> str:
    rules = (match_prompt or "").strip() or DEFAULT_MATCH_PROMPT_ZH
    active = [item for item in enabled_items if item.enabled]
    section = build_question_list_section(active)
    return f"{rules}\n\n{section}"


def build_confidence_system_prompt(*, match_prompt: str, enabled_items: List[QAItem], top_k: int = 5) -> str:
    rules = (match_prompt or "").strip() or default_confidence_match_prompt(top_k=top_k)
    if "{top_k}" in rules:
        rules = rules.format(top_k=top_k)
    active = [item for item in enabled_items if item.enabled]
    section = build_question_list_section(active)
    return f"{rules}\n\n{section}"


def build_match_messages(*, system_prompt: str, user_question: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": (user_question or "").strip()},
    ]


def _normalize_output(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    first_line = text.splitlines()[0].strip()
    first_line = re.sub(r"^[`\"']+|[`\"']+$", "", first_line)
    return first_line.strip()


def parse_match_raw(*, raw: str, valid_ids: Set[str]) -> MatchResult:
    token = _normalize_output(raw)
    if not token:
        return MatchResult(
            raw_output=raw or "",
            need_clarification=True,
            clarification_question=default_clarification_question(),
        )
    if token.upper() == NONE_SENTINEL:
        return MatchResult(
            raw_output=token,
            need_clarification=True,
            clarification_question=default_clarification_question(),
        )
    if token in valid_ids:
        return MatchResult(raw_output=token, matched_id=token)
    return MatchResult(
        raw_output=token,
        need_clarification=True,
        clarification_question=default_clarification_question(),
    )


def is_match_resolved(buffer: str, valid_ids: Set[str]) -> bool:
    token = _normalize_output(buffer)
    if not token:
        return False
    if token.upper() == NONE_SENTINEL:
        return True
    return token in valid_ids


def _strip_json_fence(text: str) -> str:
    raw = (text or "").strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    return raw


def parse_confidence_raw(*, raw: str, valid_ids: Set[str], top_k: int = 5) -> tuple[List[dict[str, Any]], str]:
    cleaned = _strip_json_fence(raw)
    if not cleaned:
        return [], raw or ""
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        return [], raw or ""
    if not isinstance(data, list):
        return [], raw or ""

    seen: set[str] = set()
    out: List[dict[str, Any]] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        item_id = str(entry.get("id") or "").strip()
        if not item_id or item_id in seen or item_id not in valid_ids:
            continue
        try:
            confidence = float(entry.get("confidence", 0))
        except (TypeError, ValueError):
            continue
        confidence = max(0.0, min(1.0, confidence))
        seen.add(item_id)
        out.append({"id": item_id, "confidence": confidence})

    out.sort(key=lambda x: x["confidence"], reverse=True)
    return out[:top_k], raw or ""
