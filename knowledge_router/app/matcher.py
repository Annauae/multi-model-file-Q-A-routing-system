"""问题匹配核心：拼 system prompt、解析模型输出。

单 id 匹配输出 q001 或 NONE；置信度匹配输出 JSON 数组 [{"id","confidence"}, ...]。
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable, List, Set

from .schemas import MatchResult, QAItem

# 单 id 匹配默认规则（kb 未配置 match_prompt 时使用）
DEFAULT_MATCH_PROMPT_ZH = """你是问题匹配器，不是回答器。
根据用户问题，从【标准问题列表】中选出语义最接近的一项。
列表中同一 id 可能出现多行（标准问题 + 其他问法），命中任意一行都输出该 id。
只输出该项的 id（如 q001）；无法匹配则只输出 NONE。
不要输出任何其他字符、标点、换行或解释。"""

# 置信度匹配默认规则；{top_k} 在 build 时 format
DEFAULT_CONFIDENCE_MATCH_PROMPT_ZH = """你是问题匹配器，不是回答器。
根据用户问题，从【标准问题列表】中找出语义最接近的若干项（最多 {top_k} 项）。
列表中同一 id 可能出现多行（标准问题 + 其他问法），命中任意一行都计入该 id。

只输出 JSON 数组，按 confidence 从高到低排列，每项格式：{{"id":"q001","confidence":0.95}}
confidence 为 0~1 之间的小数，表示匹配置信度；同一 id 只出现一次。
若无任何可匹配项，输出 []。
不要输出任何其他字符、markdown 代码块或解释。"""

NONE_SENTINEL = "NONE"  # 模型表示无匹配时的固定输出


def default_match_prompt() -> str:
    """返回单 id 匹配默认规则文本。"""
    return DEFAULT_MATCH_PROMPT_ZH


def default_confidence_match_prompt(*, top_k: int = 5) -> str:
    """返回置信度匹配默认规则，注入 top_k。"""
    return DEFAULT_CONFIDENCE_MATCH_PROMPT_ZH.format(top_k=top_k)


def default_clarification_question() -> str:
    """未匹配时返回给前端用户的默认澄清话术。"""
    return "未找到相关问题，请换一种问法或补充更具体的功能名称。"


def iter_question_prompt_lines(item: QAItem) -> List[str]:
    """Scheme A：标准问题 + 每条变体各占一行，格式 id|问法。

    同一 id 多行共享，供 LLM 在列表中匹配任意一种问法。
    """
    lines = [f"{item.id}|{item.question}"]
    seen = {item.question.strip()}  # 去重：变体与标准问题相同时跳过
    for variant in item.variants or []:
        v = (variant or "").strip()
        if not v or v in seen:
            continue
        seen.add(v)
        lines.append(f"{item.id}|{v}")
    return lines


def build_question_list_section(enabled_items: Iterable[QAItem]) -> str:
    """拼【标准问题列表】段落，追加到 system prompt 末尾。"""
    lines = ["【标准问题列表】"]
    for item in enabled_items:
        lines.extend(iter_question_prompt_lines(item))
    if len(lines) == 1:
        lines.append("(empty)")  # 无启用条目时的占位
    return "\n".join(lines)


def count_question_prompt_lines(enabled_items: Iterable[QAItem]) -> int:
    """统计 prompt 中问题行数（含变体），用于日志与监控。"""
    total = 0
    for item in enabled_items:
        if not item.enabled:
            continue
        total += len(iter_question_prompt_lines(item))
    return total


def build_match_system_prompt(*, match_prompt: str, enabled_items: List[QAItem]) -> str:
    """单 id 匹配完整 system prompt = 规则 + 空行 + 问题列表。"""
    rules = (match_prompt or "").strip() or DEFAULT_MATCH_PROMPT_ZH
    active = [item for item in enabled_items if item.enabled]
    section = build_question_list_section(active)
    return f"{rules}\n\n{section}"


def build_confidence_system_prompt(*, match_prompt: str, enabled_items: List[QAItem], top_k: int = 5) -> str:
    """置信度匹配完整 system prompt；规则可含 {top_k} 占位符。"""
    rules = (match_prompt or "").strip() or default_confidence_match_prompt(top_k=top_k)
    if "{top_k}" in rules:
        rules = rules.format(top_k=top_k)
    active = [item for item in enabled_items if item.enabled]
    section = build_question_list_section(active)
    return f"{rules}\n\n{section}"


def build_match_messages(*, system_prompt: str, user_question: str) -> list[dict[str, str]]:
    """组装 OpenAI 风格 messages：system 含规则+列表，user 为用户问题。"""
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": (user_question or "").strip()},
    ]


def _normalize_output(raw: str) -> str:
    """取模型输出首行，去掉首尾引号/反引号，用于单 token id 解析。"""
    text = (raw or "").strip()
    if not text:
        return ""
    first_line = text.splitlines()[0].strip()
    first_line = re.sub(r"^[`\"']+|[`\"']+$", "", first_line)
    return first_line.strip()


def parse_match_raw(*, raw: str, valid_ids: Set[str]) -> MatchResult:
    """解析单 id 匹配输出。

    Args:
        raw: 模型原始文本
        valid_ids: 当前 kb 启用的 id 集合

    Returns:
        MatchResult；无效/空/NONE 时 need_clarification=True
    """
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
    # 输出了未知 id（幻觉或已禁用）
    return MatchResult(
        raw_output=token,
        need_clarification=True,
        clarification_question=default_clarification_question(),
    )


def is_match_resolved(buffer: str, valid_ids: Set[str]) -> bool:
    """流式早停：缓冲区已能解析为 NONE 或合法 id 时返回 True。"""
    token = _normalize_output(buffer)
    if not token:
        return False
    if token.upper() == NONE_SENTINEL:
        return True
    return token in valid_ids


def _strip_json_fence(text: str) -> str:
    """去掉模型可能包裹的 ```json ... ``` 代码块。"""
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
    """解析置信度匹配 JSON 数组。

    Args:
        raw: 模型原始输出
        valid_ids: 合法 id 白名单
        top_k: 最多保留候选数

    Returns:
        (候选列表 [{"id","confidence"}, ...], 原始 raw 字符串)
    """
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
        confidence = max(0.0, min(1.0, confidence))  # 钳制到 [0,1]
        seen.add(item_id)
        out.append({"id": item_id, "confidence": confidence})

    out.sort(key=lambda x: x["confidence"], reverse=True)
    return out[:top_k], raw or ""
