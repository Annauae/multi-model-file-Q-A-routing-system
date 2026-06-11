from __future__ import annotations

import json
from typing import Dict, List, Tuple

from .llm_client import ChatMessage, LLMClient, LLMError


INIT_SYSTEM_PROMPT_ZH = """你是 agent 问题索引生成器。
你会收到某个 agent 的【知识内容】（纯文档/事实，不含角色设定）。
你的任务不是回答问题，而是根据知识内容总结：用户可能会问哪些问题，该 agent 适合回答什么。

要求：
- 只根据知识内容生成问题。
- 问题要像真实用户会问的话。
- 包含正式问法、口语问法、模糊问法。
- 不要只照抄标题。
- 每个 agent 生成 50 到 100 个 route_questions。
- 同时生成一条 knowledge_summary，概括知识库可支持的主题范围。
- 输出严格 JSON。

输出格式：

{
  "route_questions": [
    "用户可能提出的问题1",
    "用户可能提出的问题2"
  ],
  "knowledge_summary": "该知识库主要可以支持哪些类型的问题（一段话）"
}

注意：只输出 JSON 本体，不要输出任何额外文字、不要使用 Markdown 代码块。"""


def _extract_first_json_object(text: str) -> str:
    s = text.strip()
    if not s:
        raise ValueError("初始化模型输出为空")
    if s.startswith("{") and s.endswith("}"):
        return s
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("初始化模型输出不包含可解析的 JSON 对象")
    return s[start : end + 1]


def generate_route_questions_and_summaries(
    *,
    agent_id: str,
    agent_name: str,
    knowledge: str,
    knowledge_source: str,
    llm: LLMClient,
    init_model: str,
    min_route_questions: int,
    max_route_questions: int,
) -> Tuple[List[str], List[Dict[str, str]]]:
    body = (knowledge or "").strip()
    if not body:
        raise LLMError(
            "初始化失败：知识内容为空。请在 files/agent_{id}/ 下放置 knowledge.md（或任意 .md / .pdf）。"
        )

    payload = {
        "agent_id": agent_id,
        "agent_name": agent_name,
        "knowledge_source": knowledge_source,
        "knowledge": body,
    }

    raw = llm.chat(
        model=init_model,
        messages=[
            ChatMessage(role="system", content=INIT_SYSTEM_PROMPT_ZH),
            ChatMessage(role="user", content=json.dumps(payload, ensure_ascii=False)),
        ],
    )

    try:
        obj = json.loads(_extract_first_json_object(raw))
    except Exception as e:  # noqa: BLE001
        raise LLMError(f"初始化模型输出解析失败：{type(e).__name__}: {e}. 原始输出：{raw[:800]}") from e

    route_questions = obj.get("route_questions", [])
    knowledge_summary = str(obj.get("knowledge_summary", "") or "").strip()

    if not isinstance(route_questions, list) or not all(isinstance(x, str) and x.strip() for x in route_questions):
        raise LLMError("初始化模型输出不符合要求：route_questions 必须是字符串数组")

    route_questions = [q.strip() for q in route_questions if q and q.strip()]
    if len(route_questions) < min_route_questions:
        raise LLMError(
            f"初始化模型生成的问题数量不足（{len(route_questions)}），期望 {min_route_questions}-{max_route_questions} 条。"
        )
    if len(route_questions) > max_route_questions:
        route_questions = route_questions[:max_route_questions]

    if not knowledge_summary:
        raise LLMError("初始化模型未生成 knowledge_summary，请重试。")

    file_summaries = [{"file": knowledge_source or "knowledge", "summary": knowledge_summary}]
    return route_questions, file_summaries
