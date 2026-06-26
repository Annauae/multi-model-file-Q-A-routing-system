"""上游 LLM 客户端：OpenAI 兼容 chat/completions，含 mock 与流式早停。"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
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


@dataclass
class TokenUsageResult:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def to_dict(self) -> Dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens or (self.prompt_tokens + self.completion_tokens),
        }


@dataclass
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

    def __init__(self, settings: Settings, *, api_base_url: str | None = None, api_key: str | None = None):
        self._settings = settings
        self._api_base_url = (api_base_url or settings.api_base_url).strip()
        if api_key is not None:
            self._api_key = str(api_key).strip()
        else:
            self._api_key = (settings.api_key or "").strip()
        self._client: Optional[OpenAI] = None
        if not self._settings.mock_llm and not self._api_key and not self._is_ollama():
            raise LLMError("未配置 API_KEY，且 MOCK_LLM=0，无法调用上游模型。请先配置 .env。")

    def _is_ollama(self) -> bool:
        url = (self._api_base_url or "").lower()
        return ":11434" in url or url.rstrip("/").endswith("/11434")

    def _ollama_root_url(self) -> str:
        url = self._api_base_url.rstrip("/")
        if url.endswith("/v1"):
            return url[:-3]
        return url

    def _ollama_think_enabled(self) -> bool | None:
        return self._settings.enable_thinking

    def _use_ollama_native(self) -> bool:
        """Ollama OpenAI 兼容层无法可靠关闭 thinking；关闭时走 /api/chat。"""
        return self._is_ollama() and self._ollama_think_enabled() is False

    @staticmethod
    def _ollama_messages(messages: List[ChatMessage]) -> List[Dict[str, str]]:
        out: List[Dict[str, str]] = []
        for m in messages:
            if isinstance(m.content, list):
                parts = []
                for part in m.content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        parts.append(str(part.get("text", "")))
                content = "\n".join(p for p in parts if p)
            else:
                content = str(m.content or "")
            out.append({"role": m.role, "content": content})
        return out

    def _ollama_chat_native(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        token_limit: int,
        temperature: float,
    ) -> tuple[str, TokenUsageResult]:
        payload = {
            "model": model,
            "messages": self._ollama_messages(messages),
            "stream": False,
            "think": False,
            "options": {"num_predict": token_limit, "temperature": temperature},
        }
        data = self._ollama_post("/api/chat", payload)
        msg = data.get("message") or {}
        text = str(msg.get("content") or "").strip()
        pt = int(data.get("prompt_eval_count") or 0)
        ct = int(data.get("eval_count") or 0)
        usage = TokenUsageResult(
            prompt_tokens=pt,
            completion_tokens=ct,
            total_tokens=pt + ct if (pt or ct) else max(1, len(text.split()) if text else 0),
        )
        return text, usage

    def _ollama_chat_native_stream(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        token_limit: int,
        temperature: float,
        early_stop_check=None,
        usage_out: Optional[List[TokenUsageResult]] = None,
    ) -> Iterator[str]:
        payload = {
            "model": model,
            "messages": self._ollama_messages(messages),
            "stream": True,
            "think": False,
            "options": {"num_predict": token_limit, "temperature": temperature},
        }
        buffer = ""
        last_usage = TokenUsageResult()
        for data in self._ollama_stream("/api/chat", payload):
            msg = data.get("message") or {}
            content = msg.get("content") or ""
            if content:
                buffer += content
                yield content
                if early_stop_check and early_stop_check(buffer):
                    break
            if data.get("done"):
                pt = int(data.get("prompt_eval_count") or 0)
                ct = int(data.get("eval_count") or 0)
                last_usage = TokenUsageResult(
                    prompt_tokens=pt,
                    completion_tokens=ct,
                    total_tokens=pt + ct if (pt or ct) else max(1, len(buffer.split()) if buffer else 0),
                )
        if usage_out is not None:
            if not last_usage.total_tokens and buffer:
                last_usage = TokenUsageResult(completion_tokens=max(1, len(buffer.split())), total_tokens=max(1, len(buffer.split())))
            usage_out.append(last_usage)

    def _ollama_post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self._ollama_root_url()}{path}"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise LLMError(f"Ollama 请求失败（{e.code}）：{detail}") from e
        except urllib.error.URLError as e:
            raise LLMError(f"无法连接 Ollama（{url}）：{e.reason}") from e
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as e:
            raise LLMError(f"Ollama 响应解析失败：{raw[:200]}") from e
        if not isinstance(obj, dict):
            raise LLMError("Ollama 响应格式异常")
        return obj

    def _ollama_stream(self, path: str, payload: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
        url = f"{self._ollama_root_url()}{path}"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise LLMError(f"Ollama 流式请求失败（{e.code}）：{detail}") from e
        except urllib.error.URLError as e:
            raise LLMError(f"无法连接 Ollama（{url}）：{e.reason}") from e
        try:
            for line in resp:
                line = line.decode("utf-8").strip()
                if not line:
                    continue
                obj = json.loads(line)
                if isinstance(obj, dict):
                    yield obj
        finally:
            resp.close()

    def _model_supports_enable_thinking(self, model: str) -> bool:
        name = (model or "").lower()
        return not (name.startswith("gpt-") or "gpt-" in name)

    def _is_volc_ark(self) -> bool:
        return "volces.com" in (self._api_base_url or "").lower()

    def _is_gemini(self) -> bool:
        return "generativelanguage.googleapis.com" in (self._api_base_url or "").lower()

    def _build_extra_body(self, *, model: str) -> Dict[str, Any]:
        extra: Dict[str, Any] = {}
        if self._is_volc_ark() and self._settings.enable_thinking is not None:
            extra["thinking"] = {
                "type": "enabled" if self._settings.enable_thinking else "disabled",
            }
        elif self._is_gemini():
            if self._settings.enable_thinking is False:
                extra["reasoning_effort"] = "none"
        elif self._settings.enable_thinking is not None and self._model_supports_enable_thinking(model):
            extra["chat_template_kwargs"] = {"enable_thinking": self._settings.enable_thinking}
        if self._settings.reasoning_effort and not self._is_gemini():
            extra["reasoning_effort"] = self._settings.reasoning_effort
        return extra

    def with_credentials(self, *, api_base_url: str, api_key: str) -> "LLMClient":
        """返回使用指定端点/密钥的客户端副本。"""
        return LLMClient(self._settings, api_base_url=api_base_url, api_key=api_key)

    @property
    def client(self) -> OpenAI:
        """懒初始化 OpenAI 客户端。"""
        if self._client is None:
            self._client = OpenAI(base_url=self._api_base_url, api_key=self._api_key)
        return self._client

    def chat(
        self,
        *,
        model: str,
        messages: List[ChatMessage],
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> tuple[str, TokenUsageResult]:
        """非流式 completion，返回 (assistant 文本, token 用量)。"""
        if self._settings.mock_llm:
            text = self._mock_match(messages=messages)
            usage = TokenUsageResult(completion_tokens=max(1, len(text.split())), total_tokens=max(1, len(text.split())))
            return text, usage
        token_limit = max_tokens or self._settings.max_tokens
        temp = self._settings.match_temperature if temperature is None else temperature
        if self._use_ollama_native():
            try:
                return self._ollama_chat_native(
                    model=model,
                    messages=messages,
                    token_limit=token_limit,
                    temperature=temp,
                )
            except LLMError:
                raise
            except Exception as e:  # noqa: BLE001
                _raise_friendly_llm_error(e)
        try:
            resp = self._create_completion(
                model=model,
                messages=messages,
                token_limit=token_limit,
                temperature=temp,
            )
            text = (resp.choices[0].message.content or "").strip()
            usage = self._usage_from_response(resp, fallback_text=text)
            return text, usage
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
                    text = (resp.choices[0].message.content or "").strip()
                    usage = self._usage_from_response(resp, fallback_text=text)
                    return text, usage
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
        usage_out: Optional[List[TokenUsageResult]] = None,
    ) -> Iterator[str]:
        """流式 yield 文本片段。

        Args:
            early_stop_check: 传入累积 buffer，返回 True 时中断流（单 id 匹配早停）
            mock_mode: "match" | "confidence"，mock 时分流不同启发式
        """
        if self._settings.mock_llm:
            text = self._mock_match(messages=messages) if mock_mode != "confidence" else self._mock_confidence(messages=messages)
            usage = TokenUsageResult(completion_tokens=max(1, len(text.split())), total_tokens=max(1, len(text.split())))
            if usage_out is not None:
                usage_out.append(usage)
            step = 2
            for i in range(0, len(text), step):
                yield text[i : i + step]
            return

        token_limit = max_tokens or self._settings.max_tokens
        temp = self._settings.match_temperature if temperature is None else temperature
        if self._use_ollama_native():
            try:
                yield from self._ollama_chat_native_stream(
                    model=model,
                    messages=messages,
                    token_limit=token_limit,
                    temperature=temp,
                    early_stop_check=early_stop_check,
                    usage_out=usage_out,
                )
                return
            except LLMError:
                raise
            except Exception as e:  # noqa: BLE001
                _raise_friendly_llm_error(e)
        try:
            yield from self._create_completion_stream(
                model=model,
                messages=messages,
                token_limit=token_limit,
                temperature=temp,
                early_stop_check=early_stop_check,
                usage_out=usage_out,
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
                        usage_out=usage_out,
                    )
                    return
                except Exception as e2:  # noqa: BLE001
                    _raise_friendly_llm_error(e2)
            _raise_friendly_llm_error(e)

    @staticmethod
    def _usage_from_response(resp: Any, *, fallback_text: str = "") -> TokenUsageResult:
        usage = getattr(resp, "usage", None)
        if usage is not None:
            pt = int(getattr(usage, "prompt_tokens", 0) or 0)
            ct = int(getattr(usage, "completion_tokens", 0) or 0)
            tt = int(getattr(usage, "total_tokens", 0) or 0) or (pt + ct)
            return TokenUsageResult(prompt_tokens=pt, completion_tokens=ct, total_tokens=tt)
        ct = max(1, len((fallback_text or "").split())) if fallback_text else 0
        return TokenUsageResult(completion_tokens=ct, total_tokens=ct)

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
        extra_body = self._build_extra_body(model=model)
        if extra_body:
            kwargs["extra_body"] = extra_body
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
        usage_out: Optional[List[TokenUsageResult]] = None,
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
        last_usage: TokenUsageResult | None = None
        for chunk in stream:
            if getattr(chunk, "usage", None) is not None:
                last_usage = self._usage_from_response(chunk)
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
        if usage_out is not None:
            if last_usage is None:
                last_usage = TokenUsageResult(completion_tokens=max(1, len(buffer.split()) if buffer else 0))
            usage_out.append(last_usage)

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
