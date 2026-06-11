from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Union

from openai import OpenAI

from .config import Settings

# Sophnet Chat Completions API:
# https://www.sophnet.com/docs/component/API.html


class LLMError(RuntimeError):
    pass


def _raise_friendly_llm_error(e: Exception) -> None:
    msg = str(e)
    if "AuthenticationError" in msg or "401" in msg or "API key format is incorrect" in msg:
        raise LLMError(
            "上游模型鉴权失败（401）。请检查 .env 中的 API_KEY 是否为火山方舟控制台生成的 Key，"
            "并确认系统环境变量 ARK_API_KEY 未覆盖 .env；修改后需重启 uvicorn。"
        ) from e
    if "AccessDenied" in msg or "PermissionDeniedError" in msg or "403" in msg:
        raise LLMError(
            "上游模型无权限访问该接入点（403）。请确认 ep-xxx 接入点与 API_KEY 属于同一火山方舟项目；"
            "若 .env 中 API_KEY 正确，请检查系统环境变量 ARK_API_KEY 是否覆盖了 .env。"
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

    def chat(self, *, model: str, messages: List[ChatMessage], max_tokens: Optional[int] = None) -> str:
        if self._settings.mock_llm:
            return self._mock_chat(model=model, messages=messages)

        token_limit = max_tokens or self._settings.max_tokens
        try:
            resp = self._create_completion(model=model, messages=messages, token_limit=token_limit)
            content = (resp.choices[0].message.content or "").strip()
            return content
        except Exception as e:  # noqa: BLE001 - return readable API error
            msg = str(e)
            if "Unsupported parameter: 'max_tokens'" in msg or "max_completion_tokens" in msg:
                try:
                    resp = self._create_completion(
                        model=model,
                        messages=messages,
                        token_limit=token_limit,
                        force_max_completion_tokens=True,
                    )
                    content = (resp.choices[0].message.content or "").strip()
                    return content
                except Exception as e2:  # noqa: BLE001
                    _raise_friendly_llm_error(e2)
            _raise_friendly_llm_error(e)

    def chat_stream(self, *, model: str, messages: List[ChatMessage], max_tokens: Optional[int] = None) -> Iterator[str]:
        if self._settings.mock_llm:
            yield from self._mock_chat_stream(model=model, messages=messages)
            return

        token_limit = max_tokens or self._settings.max_tokens
        try:
            yield from self._create_completion_stream(
                model=model,
                messages=messages,
                token_limit=token_limit,
            )
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
        # gpt-5.4 on Sophnet rejects enable_thinking even when false.
        name = (model or "").lower()
        return not (name.startswith("gpt-") or "gpt-" in name)

    def _is_volc_ark(self) -> bool:
        return "volces.com" in (self._settings.api_base_url or "").lower()

    def _build_extra_body(self, *, model: str) -> Dict[str, Any]:
        """Vendor-specific body fields (via OpenAI SDK extra_body)."""
        extra: Dict[str, Any] = {}

        if self._is_volc_ark() and self._settings.enable_thinking is not None:
            extra["thinking"] = {
                "type": "enabled" if self._settings.enable_thinking else "disabled",
            }
        elif self._settings.enable_thinking is not None and self._model_supports_enable_thinking(model):
            extra["chat_template_kwargs"] = {"enable_thinking": self._settings.enable_thinking}

        if self._settings.reasoning_effort:
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
            "temperature": 1,
            "stream": stream,
        }

        # Sophnet: max_tokens 与 max_completion_tokens 只能二选一
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
            # 流式：只输出正文 content，忽略 reasoning_content 思考链
            content = getattr(delta, "content", None)
            if content:
                yield content

    def _mock_chat(self, *, model: str, messages: List[ChatMessage]) -> str:
        if model == self._settings.router_model:
            agent_id = "1"
            try:
                user_text = next((m.content for m in reversed(messages) if m.role == "user"), "")
                obj = json.loads(user_text) if isinstance(user_text, str) else {}
                cands = obj.get("candidates", []) or []
                if cands and isinstance(cands[0], dict):
                    agent_id = str(cands[0].get("agent_id", agent_id) or agent_id)
            except Exception:
                pass
            payload = {
                "target_agents": [{"agent_id": agent_id}],
                "need_clarification": False,
                "clarification_question": "",
            }
            return json.dumps(payload, ensure_ascii=False)

        if model == self._settings.init_model:
            route_questions = [f"（MOCK）可回答问题 {i}" for i in range(1, 51)]
            payload = {
                "route_questions": route_questions,
                "knowledge_summary": "（MOCK）该知识库可支持的问题范围。",
            }
            return json.dumps(payload, ensure_ascii=False)

        try:
            sys_text = next((m.content for m in messages if m.role == "system"), "")
            if isinstance(sys_text, str) and "多 agent 回答合并器（图文版）" in sys_text:
                user_text = next((m.content for m in reversed(messages) if m.role == "user"), "")
                candidates = []
                try:
                    obj = json.loads(user_text) if isinstance(user_text, str) else {}
                    candidates = obj.get("candidates", []) or []
                except Exception:
                    candidates = []
                ill = []
                for c in candidates:
                    if not isinstance(c, dict):
                        continue
                    f = str(c.get("file", "")).lower()
                    if f.endswith(".pdf") and c.get("page"):
                        ill = [{"file": c.get("file", ""), "page": c.get("page"), "caption": "相关证据页预览"}]
                        break
                    if f.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
                        ill = [{"file": c.get("file", ""), "page": None, "caption": c.get("snippet") or "相关示意图"}]
                        break
                payload = {
                    "merged_answer": "\n".join(
                        [
                            "（MOCK）这是合并后的最终回答，直接面向用户说明结论与可执行步骤。",
                            "",
                            "如需更精确结论，请补充更多相关文件。",
                        ]
                    ),
                    "illustrations": ill,
                }
                return json.dumps(payload, ensure_ascii=False)
        except Exception:
            pass

        try:
            sys_text = next((m.content for m in messages if m.role == "system"), "")
            if isinstance(sys_text, str) and "问答质量评估员" in sys_text:
                return json.dumps(
                    {"accuracy_percent": 85, "reason": "（MOCK）模型回答与参考基本一致"},
                    ensure_ascii=False,
                )
        except Exception:
            pass

        return "\n".join(
            [
                "快门释放按钮位于机身顶部中央。",
                "电源开关在快门按钮周围。",
            ]
        ).strip()

    def _mock_chat_stream(self, *, model: str, messages: List[ChatMessage]) -> Iterator[str]:
        text = self._mock_chat(model=model, messages=messages)
        step = 12
        for i in range(0, len(text), step):
            yield text[i : i + step]
