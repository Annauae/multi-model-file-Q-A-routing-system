from __future__ import annotations

import json
from typing import Dict, List

from .llm_client import ChatMessage, LLMClient, LLMError
from .schemas import RouterResult, RouterTargetAgent


ROUTER_SYSTEM_PROMPT_ZH = """你是问题路由模型。  
你的任务不是回答用户问题，而是根据用户问题，判断它最接近哪一个 agent 的 route_questions。

你会收到：
1. 用户问题
2. 候选 agent 列表
3. 每个 agent 对应的 route_questions

判断规则：
1. 优先比较用户问题与 route_questions 的语义相似度。
2. 不要只看关键词，要理解真实意图。
3. 只能选择一个最匹配的 agent；target_agents 数组最多 1 项。
4. 如果没有任何 agent 的 route_questions 能覆盖该问题，返回 need_clarification=true。
5. 不要直接回答用户问题。
6. 不要编造不存在的 agent_id。

严格输出 JSON（target_agents 只需 agent_id，不要输出 reason、rewritten_query、matched_route_questions、confidence 等字段）：

{
  "target_agents": [
    {
      "agent_id": "1"
    }
  ],
  "need_clarification": false,
  "clarification_question": ""
}

如果无法判断，输出：

{
  "target_agents": [],
  "need_clarification": true,
  "clarification_question": "请补充你想查询的是哪类文件内容，例如财报、合同还是技术文档？"
}

也允许 target_agents 为字符串数组，例如 ["1"]。

注意：只输出 JSON 本体，不要输出任何额外文字、不要使用 Markdown 代码块。"""


def _extract_first_json_object(text: str) -> str:
    s = text.strip()
    if not s:
        raise ValueError("路由模型输出为空")

    if s.startswith("{") and s.endswith("}"):
        return s

    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("路由模型输出不包含可解析的 JSON 对象")
    return s[start : end + 1]


def _default_clarification_question() -> str:
    return "未能匹配到合适的说明书章节，请换一种问法，或补充更具体的功能名称（例如「显示屏模式」「眼感应切换」）。"


def _pick_single_target(targets: List[RouterTargetAgent]) -> List[RouterTargetAgent]:
    if not targets:
        return []
    high = [t for t in targets if t.confidence == "high"]
    chosen = high[0] if high else targets[0]
    return [chosen]


def _eligible_agents(agents: Dict[str, Dict]) -> Dict[str, Dict]:
    eligible: Dict[str, Dict] = {}
    for agent_id, cfg in agents.items():
        if not isinstance(cfg, dict):
            continue
        if cfg.get("status") != "initialized":
            continue
        rqs = cfg.get("route_questions", [])
        if not isinstance(rqs, list) or len([x for x in rqs if isinstance(x, str) and x.strip()]) == 0:
            continue
        eligible[agent_id] = cfg
    return eligible


def _build_route_messages(*, question: str, eligible_agents: Dict[str, Dict]) -> List[ChatMessage]:
    candidates: List[Dict] = []
    for agent_id, cfg in eligible_agents.items():
        candidates.append(
            {
                "agent_id": agent_id,
                "name": cfg.get("name", ""),
                "route_questions": cfg.get("route_questions", []),
            }
        )
    user_payload = {"question": question, "candidates": candidates}
    return [
        ChatMessage(role="system", content=ROUTER_SYSTEM_PROMPT_ZH),
        ChatMessage(role="user", content=json.dumps(user_payload, ensure_ascii=False)),
    ]


def _no_agents_result() -> RouterResult:
    return RouterResult(
        target_agents=[],
        need_clarification=True,
        clarification_question="当前没有已初始化的 agent。请先创建 agent、注册/上传文件，并调用 /agents/{agent_id}/initialize 生成 route_questions。",
    )


def _normalize_route_payload(obj: dict) -> dict:
    raw_targets = obj.get("target_agents", [])
    if not isinstance(raw_targets, list):
        raw_targets = []
    normalized: List[dict] = []
    for item in raw_targets:
        if isinstance(item, str) and item.strip():
            normalized.append({"agent_id": item.strip()})
        elif isinstance(item, dict) and str(item.get("agent_id", "")).strip():
            normalized.append({"agent_id": str(item["agent_id"]).strip()})
    obj = dict(obj)
    obj["target_agents"] = normalized
    return obj


def parse_route_raw(*, raw: str, eligible_agents: Dict[str, Dict]) -> RouterResult:
    try:
        obj = _normalize_route_payload(json.loads(_extract_first_json_object(raw)))
    except Exception as e:  # noqa: BLE001
        raise LLMError(f"路由模型输出解析失败：{type(e).__name__}: {e}. 原始输出：{raw[:800]}") from e

    try:
        parsed = RouterResult.model_validate(obj)
    except Exception as e:  # noqa: BLE001
        raise LLMError(f"路由模型输出结构不符合要求：{type(e).__name__}: {e}. 解析后的 JSON：{obj}") from e

    valid_targets: List[RouterTargetAgent] = []
    for t in parsed.target_agents:
        if t.agent_id in eligible_agents:
            valid_targets.append(t)

    need_clarification = parsed.need_clarification or (len(valid_targets) == 0)
    clarification_question = (parsed.clarification_question or "").strip()
    if need_clarification and not clarification_question:
        clarification_question = _default_clarification_question()

    single_targets = _pick_single_target(valid_targets) if not need_clarification else []

    return RouterResult(
        target_agents=single_targets,
        need_clarification=need_clarification,
        clarification_question=clarification_question if need_clarification else "",
    )


def route_question(
    *,
    question: str,
    agents: Dict[str, Dict],
    llm: LLMClient,
    router_model: str,
) -> RouterResult:
    eligible_agents = get_eligible_agents(agents)
    if not eligible_agents:
        return no_agents_router_result()

    messages = build_route_messages(question=question, eligible_agents=eligible_agents)
    raw = llm.chat(model=router_model, messages=messages)
    return parse_route_raw(raw=raw, eligible_agents=eligible_agents)


def get_eligible_agents(agents: Dict[str, Dict]) -> Dict[str, Dict]:
    return _eligible_agents(agents)


def no_agents_router_result() -> RouterResult:
    return _no_agents_result()


def build_route_messages(*, question: str, eligible_agents: Dict[str, Dict]) -> List[ChatMessage]:
    return _build_route_messages(question=question, eligible_agents=eligible_agents)
