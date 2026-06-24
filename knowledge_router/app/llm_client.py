from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Union

from openai import OpenAI

from .config import Settings
from .matcher import NONE_SENTINEL


class LLMError(RuntimeError):
    pass


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
    role: str
    content: Union[str, List[Dict[str, Any]]]

    def to_openai(self, *, use_content_parts: bool) -> Dict[str, Any]:
        if isinstance(self.content, list):
            return {"role": self.role, "content": self.content}
        if use_content_parts and isinstance(self.content, str) and self.role == "user":
            return {"role": self.role, "content": [{"type": "text", "text": self.content}]}
        return {"role": self.role, "content": self.content}


class LLMClient:
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

    def chat(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> str:
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
