"""
llm_client.py — OpenAI 兼容 Chat Completions 客户端

职责：
  - chat()：同步调用（POST /ask）
  - chat_stream()：流式调用（POST /ask/stream，用于匹配首字/匹配完成耗时）
  - 适配多网关：max_tokens vs max_completion_tokens、thinking、Gemini 等
  - MOCK_LLM=1 时返回固定 JSON，不消耗 API（测试 / 本地开发）

阅读顺序：第 8 个（基础设施；matcher 与 main 均依赖本模块）
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Union

from openai import OpenAI

from .config import Settings


class LLMError(RuntimeError):
    """上游模型调用失败时抛出；main.py 转为 HTTP 502。"""


def _raise_friendly_llm_error(e: Exception) -> None:
    msg = str(e)
    if "AuthenticationError" in msg or "401" in msg or "API key format is incorrect" in msg:
        raise LLMError(
            "上游模型鉴权失败（401）。请检查 .env 中的 API_KEY 是否有效，"
            "并确认系统环境变量未覆盖 .env；修改后需重启服务。"
        ) from e
    if "AccessDenied" in msg or "PermissionDeniedError" in msg or "403" in msg:
        raise LLMError(
            "上游模型无权限访问（403）。请确认 API_KEY 与接入点/模型匹配。"
        ) from e
    raise LLMError(f"调用上游模型失败：{type(e).__name__}: {e}") from e


@dataclass(frozen=True)
class ChatMessage:
    """OpenAI messages 格式的轻量封装；matcher.build_match_messages 产出此结构。"""

    role: str
    content: Union[str, List[Dict[str, Any]]]

    def to_openai(self, *, use_content_parts: bool) -> Dict[str, Any]:
        if isinstance(self.content, list):
            return {"role": self.role, "content": self.content}
        if use_content_parts and isinstance(self.content, str) and self.role == "user":
            return {"role": self.role, "content": [{"type": "text", "text": self.content}]}
        return {"role": self.role, "content": self.content}


class LLMClient:
    """匹配模型的唯一 HTTP 出口；settings.match_model 指定模型名。"""

    def __init__(self, settings: Settings):
        self._settings = settings
        self._client: Optional[OpenAI] = None
        if not self._settings.mock_llm and not self._settings.api_key:
            raise LLMError("未配置 API_KEY，且 MOCK_LLM=0，无法调用上游模型。请先配置 .env。")

    @property
    def client(self) -> OpenAI:
        if self._client is None:
            self._client = OpenAI(base_url=self._settings.api_base_url, api_key=self._settings.api_key)
        return self._client

    def chat(self, *, model: str, messages: List[ChatMessage], max_tokens: Optional[int] = None) -> str:
        """同步 completion；返回 assistant 文本（匹配场景下为 JSON 字符串）。"""
        if self._settings.mock_llm:
            return self._mock_chat(model=model, messages=messages)
        token_limit = max_tokens or self._settings.max_tokens
        try:
            resp = self._create_completion(model=model, messages=messages, token_limit=token_limit)
            return (resp.choices[0].message.content or "").strip()
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "Unsupported parameter: 'max_tokens'" in msg or "max_completion_tokens" in msg:
                try:
                    resp = self._create_completion(
                        model=model,
                        messages=messages,
                        token_limit=token_limit,
                        force_max_completion_tokens=True,
                    )
                    return (resp.choices[0].message.content or "").strip()
                except Exception as e2:  # noqa: BLE001
                    _raise_friendly_llm_error(e2)
            _raise_friendly_llm_error(e)

    def chat_stream(self, *, model: str, messages: List[ChatMessage], max_tokens: Optional[int] = None) -> Iterator[str]:
        """流式 completion；main.py 用于统计 match_first_token_ms 并在日志中展示 raw JSON 流。"""
        if self._settings.mock_llm:
            yield from self._mock_chat_stream(model=model, messages=messages)
            return
        token_limit = max_tokens or self._settings.max_tokens
        try:
            yield from self._create_completion_stream(model=model, messages=messages, token_limit=token_limit)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "Unsupported parameter: 'max_tokens'" in msg or "max_completion_tokens" in msg:
                try:
                    yield from self._create_completion_stream(
                        model=model,
                        messages=messages,
                        token_limit=token_limit,
                        force_max_completion_tokens=True,
                    )
                    return
                except Exception as e2:  # noqa: BLE001
                    _raise_friendly_llm_error(e2)
            _raise_friendly_llm_error(e)

    def _model_supports_enable_thinking(self, model: str) -> bool:
        name = (model or "").lower()
        return not (name.startswith("gpt-") or "gpt-" in name)

    def _is_volc_ark(self) -> bool:
        return "volces.com" in (self._settings.api_base_url or "").lower()

    def _is_gemini(self) -> bool:
        return "generativelanguage.googleapis.com" in (self._settings.api_base_url or "").lower()

    def _build_extra_body(self, *, model: str) -> Dict[str, Any]:
        extra: Dict[str, Any] = {}
        if self._is_volc_ark() and self._settings.enable_thinking is not None:
            extra["thinking"] = {"type": "enabled" if self._settings.enable_thinking else "disabled"}
        elif self._is_gemini():
            if self._settings.enable_thinking is False:
                extra["reasoning_effort"] = "none"
        elif self._settings.enable_thinking is not None and self._model_supports_enable_thinking(model):
            extra["chat_template_kwargs"] = {"enable_thinking": self._settings.enable_thinking}
        if self._settings.reasoning_effort and not self._is_gemini():
            extra["reasoning_effort"] = self._settings.reasoning_effort
        return extra

    def _build_completion_kwargs(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        token_limit: int,
        force_max_completion_tokens: bool = False,
        stream: bool = False,
    ) -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": [m.to_openai(use_content_parts=self._settings.use_content_parts) for m in messages],
            "temperature": self._settings.llm_temperature,
            "stream": stream,
        }
        if force_max_completion_tokens or self._settings.use_max_completion_tokens:
            kwargs["max_completion_tokens"] = token_limit
        else:
            kwargs["max_tokens"] = token_limit
        extra_body = self._build_extra_body(model=model)
        if extra_body:
            kwargs["extra_body"] = extra_body
        return kwargs

    def _create_completion(self, *, model: str, messages: List[ChatMessage], token_limit: int, force_max_completion_tokens: bool = False):
        kwargs = self._build_completion_kwargs(
            model=model,
            messages=messages,
            token_limit=token_limit,
            force_max_completion_tokens=force_max_completion_tokens,
            stream=False,
        )
        return self.client.chat.completions.create(**kwargs)

    def _create_completion_stream(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        token_limit: int,
        force_max_completion_tokens: bool = False,
    ) -> Iterator[str]:
        kwargs = self._build_completion_kwargs(
            model=model,
            messages=messages,
            token_limit=token_limit,
            force_max_completion_tokens=force_max_completion_tokens,
            stream=True,
        )
        stream = self.client.chat.completions.create(**kwargs)
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if content:
                yield content

    def _mock_chat(self, *, model: str, messages: List[ChatMessage]) -> str:
        """MOCK_LLM=1：匹配模型固定返回第一个 candidate 的 id（tests 用）。"""
        if model == self._settings.match_model:
            matched_id = "q001"
            try:
                user_text = next((m.content for m in reversed(messages) if m.role == "user"), "")
                obj = json.loads(user_text) if isinstance(user_text, str) else {}
                cands = obj.get("candidates", []) or []
                if cands and isinstance(cands[0], dict):
                    matched_id = str(cands[0].get("id", matched_id) or matched_id)
            except Exception:
                pass
            payload = {
                "matched_id": matched_id,
                "need_clarification": False,
                "clarification_question": "",
            }
            return json.dumps(payload, ensure_ascii=False)
        return "{}"

    def _mock_chat_stream(self, *, model: str, messages: List[ChatMessage]) -> Iterator[str]:
        text = self._mock_chat(model=model, messages=messages)
        step = 12
        for i in range(0, len(text), step):
            yield text[i : i + step]
