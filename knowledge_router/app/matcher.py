"""
matcher.py — 匹配模型：语义选 FAQ + 解析 JSON

职责（本系统唯一的 LLM 业务逻辑）：
  1. build_match_messages：组装 system（匹配提示词）+ user（用户问题 + 候选 FAQ）
  2. match_question：调用 LLMClient.chat，同步匹配
  3. parse_match_raw：从模型输出 JSON 提取 matched_id，校验 id 合法

注意：
  - 本模块不生成 answer；answer 由 questions_cache.get_item_by_id 提供
  - MATCH_SYSTEM_PROMPT_ZH 可被 knowledge_bases.json 中 match_prompt 覆盖

阅读顺序：第 7 个（在 llm_client 之前读也可，但调用链上在 cache 之后、llm 之前）
"""

from __future__ import annotations

import json
from typing import Dict, List

from .llm_client import ChatMessage, LLMClient, LLMError
from .schemas import MatchCandidate, MatchResult


# 默认匹配提示词：要求模型只输出 JSON，不回答用户问题
MATCH_SYSTEM_PROMPT_ZH = """你是问题匹配模型。
你的任务不是回答用户问题，而是根据用户问题，判断它最接近哪一条标准 FAQ（question 或 variants）。

你会收到：
1. 用户问题
2. 候选 FAQ 列表（每条含 id、question、variants）

判断规则：
1. 优先比较用户问题与 question / variants 的语义相似度。
2. 不要只看关键词，要理解真实意图。
3. 只能选择一个最匹配的条目；matched_id 最多 1 个。
4. 如果没有任何 FAQ 能覆盖该问题，返回 need_clarification=true。
5. 不要直接回答用户问题。
6. 不要编造不存在的 id。

严格输出 JSON：

{
  "matched_id": "q001",
  "need_clarification": false,
  "clarification_question": ""
}

如果无法判断，输出：

{
  "matched_id": "",
  "need_clarification": true,
  "clarification_question": "请换一种问法，或补充更具体的关键词。"
}

注意：只输出 JSON 本体，不要输出任何额外文字、不要使用 Markdown 代码块。"""


def _extract_first_json_object(text: str) -> str:
    """从模型输出中提取第一个 {...} 片段（兼容模型多输出废话的情况）。"""
    s = text.strip()
    if not s:
        raise ValueError("匹配模型输出为空")
    if s.startswith("{") and s.endswith("}"):
        return s
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("匹配模型输出不包含可解析的 JSON 对象")
    return s[start : end + 1]


def _default_clarification_question() -> str:
    return "未能匹配到合适的标准问题，请换一种问法，或补充更具体的功能名称。"


def _match_system_prompt(match_prompt: str = "") -> str:
    """知识库自定义提示词优先，否则用 MATCH_SYSTEM_PROMPT_ZH。"""
    custom = (match_prompt or "").strip()
    return custom if custom else MATCH_SYSTEM_PROMPT_ZH


def build_match_messages(
    *,
    question: str,
    candidates: List[MatchCandidate],
    match_prompt: str = "",
) -> List[ChatMessage]:
    """
    构造发给匹配模型的 messages。
    user 内容为 JSON 字符串：{ question, candidates[] }
    candidates 不含 answer，减少 token 并避免模型直接抄答案。
    """
    payload = {
        "question": question,
        "candidates": [c.model_dump(mode="json") for c in candidates],
    }
    return [
        ChatMessage(role="system", content=_match_system_prompt(match_prompt)),
        ChatMessage(role="user", content=json.dumps(payload, ensure_ascii=False)),
    ]


def parse_match_raw(*, raw: str, candidates: List[MatchCandidate]) -> MatchResult:
    """
    解析匹配模型原始输出。
    - matched_id 必须在 candidates 中存在，否则视为 need_clarification
    - 成功时填充 matched_question / matched_variants 供前端展示
    """
    valid_ids = {c.id for c in candidates}
    id_to_candidate = {c.id: c for c in candidates}
    try:
        obj = json.loads(_extract_first_json_object(raw))
    except Exception as e:  # noqa: BLE001
        raise LLMError(f"匹配模型输出解析失败：{type(e).__name__}: {e}. 原始输出：{raw[:800]}") from e

    matched_id = str(obj.get("matched_id", "") or "").strip()
    need_clarification = bool(obj.get("need_clarification", False))
    clarification_question = str(obj.get("clarification_question", "") or "").strip()

    if matched_id and matched_id in valid_ids:
        cand = id_to_candidate[matched_id]
        return MatchResult(
            matched_id=matched_id,
            matched_question=cand.question,
            matched_variants=list(cand.variants or []),
            need_clarification=False,
            clarification_question="",
        )

    need_clarification = True
    if not clarification_question:
        clarification_question = _default_clarification_question()
    return MatchResult(
        matched_id="",
        matched_question="",
        matched_variants=[],
        need_clarification=need_clarification,
        clarification_question=clarification_question,
    )


def no_candidates_result() -> MatchResult:
    """知识库没有任何 enabled FAQ 时的短路结果（不调 LLM）。"""
    return MatchResult(
        matched_id="",
        matched_question="",
        matched_variants=[],
        need_clarification=True,
        clarification_question="当前知识库没有启用的标准问题，请先在管理页添加 FAQ 条目。",
    )


def match_question(
    *,
    question: str,
    candidates: List[MatchCandidate],
    llm: LLMClient,
    match_model: str,
    match_prompt: str = "",
) -> MatchResult:
    """
    同步匹配入口（POST /ask 使用）。
    流程：无候选 → 直接 clarification；否则 LLM chat → parse_match_raw。
    """
    if not candidates:
        return no_candidates_result()
    messages = build_match_messages(question=question, candidates=candidates, match_prompt=match_prompt)
    raw = llm.chat(model=match_model, messages=messages)
    return parse_match_raw(raw=raw, candidates=candidates)
