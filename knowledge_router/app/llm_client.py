"""上游 LLM 客户端：OpenAI 兼容 chat/completions，含 mock 与流式早停。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Union

from openai import OpenAI

from .config import Settings
from .matcher import NONE_SENTINEL


class LLMError(RuntimeError):
    """模型调用失败时抛出，main 层转为 HTTP 502。"""


def _raise_friendly_llm_error(e: Exception) -> None:
    """将 OpenAI SDK 异常转为用户可读中文提示。"""
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
    """单条对话消息。"""

    role: str  # system / user / assistant
    content: Union[str, List[Dict[str, Any]]]  # 纯文本或多模态 parts

    def to_openai(self, *, use_content_parts: bool) -> Dict[str, Any]:
        """转为 OpenAI API messages 元素。"""
        if isinstance(self.content, list):
            return {"role": self.role, "content": self.content}
        # 部分厂商要求 user 内容为 [{"type":"text","text":"..."}]
        if use_content_parts and isinstance(self.content, str) and self.role == "user":
            return {"role": self.role, "content": [{"type": "text", "text": self.content}]}
        return {"role": self.role, "content": self.content}


class LLMClient:
    """封装 chat.completions 同步/流式调用。"""

    def __init__(self, settings: Settings):
        self._settings = settings
        self._client: Optional[OpenAI] = None
        if not self._settings.mock_llm and not self._settings.api_key:
            raise LLMError("未配置 API_KEY，且 MOCK_LLM=0，无法调用上游模型。请先配置 .env。")

    @property
    def client(self) -> OpenAI:
        """懒初始化 OpenAI 客户端。"""
        if self._client is None:
            self._client = OpenAI(base_url=self._settings.api_base_url, api_key=self._settings.api_key)
        return self._client

    def chat(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> str:
        """非流式 completion，返回完整 assistant 文本（用于导入等场景）。"""
        if self._settings.mock_llm:
            return self._mock_match(messages=messages)
        token_limit = max_tokens or self._settings.max_tokens
        temp = self._settings.match_temperature if temperature is None else temperature
        try:
            resp = self._create_completion(
                model=model,
                messages=messages,
                token_limit=token_limit,
                temperature=temp,
            )
            return (resp.choices[0].message.content or "").strip()
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            # 兼容只支持 max_completion_tokens 的端点
            if "Unsupported parameter: 'max_tokens'" in msg or "max_completion_tokens" in msg:
                try:
                    resp = self._create_completion(
                        model=model,
                        messages=messages,
                        token_limit=token_limit,
                        temperature=temp,
                        force_max_completion_tokens=True,
                    )
                    return (resp.choices[0].message.content or "").strip()
                except Exception as e2:  # noqa: BLE001
                    _raise_friendly_llm_error(e2)
            _raise_friendly_llm_error(e)

    def chat_stream(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        early_stop_check=None,
        mock_mode: str = "match",
    ) -> Iterator[str]:
        """流式 yield 文本片段。

        Args:
            early_stop_check: 传入累积 buffer，返回 True 时中断流（单 id 匹配早停）
            mock_mode: "match" | "confidence"，mock 时分流不同启发式
        """
        if self._settings.mock_llm:
            text = self._mock_match(messages=messages) if mock_mode != "confidence" else self._mock_confidence(messages=messages)
            step = 2
            for i in range(0, len(text), step):
                yield text[i : i + step]
            return

        token_limit = max_tokens or self._settings.max_tokens
        temp = self._settings.match_temperature if temperature is None else temperature
        try:
            yield from self._create_completion_stream(
                model=model,
                messages=messages,
                token_limit=token_limit,
                temperature=temp,
                early_stop_check=early_stop_check,
            )
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "Unsupported parameter: 'max_tokens'" in msg or "max_completion_tokens" in msg:
                try:
                    yield from self._create_completion_stream(
                        model=model,
                        messages=messages,
                        token_limit=token_limit,
                        temperature=temp,
                        force_max_completion_tokens=True,
                        early_stop_check=early_stop_check,
                    )
                    return
                except Exception as e2:  # noqa: BLE001
                    _raise_friendly_llm_error(e2)
            _raise_friendly_llm_error(e)

    def _build_completion_kwargs(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        token_limit: int,
        temperature: float,
        force_max_completion_tokens: bool = False,
        stream: bool = False,
    ) -> Dict[str, Any]:
        """组装 create() 参数字典。"""
        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": [m.to_openai(use_content_parts=self._settings.use_content_parts) for m in messages],
            "temperature": temperature,
            "stream": stream,
        }
        if force_max_completion_tokens or self._settings.use_max_completion_tokens:
            kwargs["max_completion_tokens"] = token_limit
        else:
            kwargs["max_tokens"] = token_limit
        return kwargs

    def _create_completion(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        token_limit: int,
        temperature: float,
        force_max_completion_tokens: bool = False,
    ):
        kwargs = self._build_completion_kwargs(
            model=model,
            messages=messages,
            token_limit=token_limit,
            temperature=temperature,
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
        temperature: float,
        force_max_completion_tokens: bool = False,
        early_stop_check=None,
    ) -> Iterator[str]:
        """消费 SSE chunk，逐段 yield content；支持 early_stop_check。"""
        kwargs = self._build_completion_kwargs(
            model=model,
            messages=messages,
            token_limit=token_limit,
            temperature=temperature,
            force_max_completion_tokens=force_max_completion_tokens,
            stream=True,
        )
        stream = self.client.chat.completions.create(**kwargs)
        buffer = ""
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if not content:
                continue
            buffer += content
            yield content
            if early_stop_check and early_stop_check(buffer):
                break

    def _mock_match(self, *, messages: List[ChatMessage]) -> str:
        """本地 mock：在 system 问题列表中做简单子串匹配，返回 id 或 NONE。"""
        user_text = next((m.content for m in reversed(messages) if m.role == "user"), "")
        if not isinstance(user_text, str):
            user_text = str(user_text)
        q = user_text.strip().lower()
        if not q or "不知道" in q or "无关" in q:
            return NONE_SENTINEL
        system_text = next((m.content for m in messages if m.role == "system"), "")
        if isinstance(system_text, str):
            for line in system_text.splitlines():
                line = line.strip()
                if "|" not in line:
                    continue
                item_id, question = line.split("|", 1)
                item_id = item_id.strip()
                question = question.strip().lower()
                if not item_id or item_id.startswith("("):
                    continue
                if q in question or question[:4] in q:
                    return item_id
        return "q001"

    def _mock_confidence(self, *, messages: List[ChatMessage]) -> str:
        """本地 mock：返回 JSON 数组，含多个 id 与启发式 confidence。"""
        user_text = next((m.content for m in reversed(messages) if m.role == "user"), "")
        if not isinstance(user_text, str):
            user_text = str(user_text)
        q = user_text.strip().lower()
        if not q or "不知道" in q or "无关" in q:
            return "[]"
        hits: list[tuple[str, float]] = []
        system_text = next((m.content for m in messages if m.role == "system"), "")
        if isinstance(system_text, str):
            for line in system_text.splitlines():
                line = line.strip()
                if "|" not in line:
                    continue
                item_id, question = line.split("|", 1)
                item_id = item_id.strip()
                question = question.strip().lower()
                if not item_id or item_id.startswith("("):
                    continue
                score = 0.0
                if q in question or question in q:
                    score = 0.92
                elif question[:4] in q or q[:4] in question:
                    score = 0.55
                if score > 0 and not any(h[0] == item_id for h in hits):
                    hits.append((item_id, score))
        if not hits:
            hits = [("q001", 0.75)]
        hits.sort(key=lambda x: x[1], reverse=True)
        payload = [{"id": item_id, "confidence": conf} for item_id, conf in hits[:5]]
        return json.dumps(payload, ensure_ascii=False)
