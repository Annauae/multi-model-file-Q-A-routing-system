from __future__ import annotations

import json
from typing import Any, Dict, Optional, Tuple

from .llm_client import ChatMessage, LLMClient, LLMError

EVAL_SYSTEM_PROMPT = """你是问答质量评估员。
你会收到：用户问题、参考回答、模型回答。
请判断模型回答相对参考回答的准确程度（0-100 整数），不要求字面一致，关注：
- 事实与步骤是否与参考一致
- 是否遗漏关键步骤
- 是否编造参考中没有的信息

严格输出 JSON（不要 Markdown 代码块）：
{"accuracy_percent": 85, "reason": "一句话说明"}

accuracy_percent 为 0-100 的整数。"""


def _extract_first_json_object(text: str) -> str:
    s = (text or "").strip()
    if s.startswith("{") and s.endswith("}"):
        return s
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("评估模型输出不包含 JSON 对象")
    return s[start : end + 1]


def evaluate_answer_accuracy(
    *,
    question: str,
    reference_answer: str,
    model_answer: str,
    llm: LLMClient,
    model: str,
) -> Tuple[Optional[int], str]:
    if not (model_answer or "").strip():
        return None, "模型回答为空"
    user = (
        f"【用户问题】\n{question.strip()}\n\n"
        f"【参考回答】\n{reference_answer.strip()}\n\n"
        f"【模型回答】\n{model_answer.strip()}"
    )
    try:
        raw = llm.chat(
            model=model,
            messages=[
                ChatMessage(role="system", content=EVAL_SYSTEM_PROMPT),
                ChatMessage(role="user", content=user),
            ],
        )
        obj: Dict[str, Any] = json.loads(_extract_first_json_object(raw))
        pct = obj.get("accuracy_percent")
        reason = str(obj.get("reason") or "").strip()
        if pct is None:
            return None, reason or "评估结果缺少 accuracy_percent"
        try:
            n = int(round(float(pct)))
        except (TypeError, ValueError):
            return None, reason or "accuracy_percent 不是有效数字"
        n = max(0, min(100, n))
        return n, reason
    except (LLMError, json.JSONDecodeError, ValueError) as e:
        return None, str(e)
