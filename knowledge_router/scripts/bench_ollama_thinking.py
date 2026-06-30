"""Benchmark Ollama qwen3.5:2b with thinking on vs off."""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from knowledge_router.app.config import Settings
from knowledge_router.app.llm_client import ChatMessage, LLMClient

QUESTION = "怎么调光圈？"
SYSTEM = """你是问题匹配器，不是回答器。
根据用户问题，从【标准问题列表】中找出语义最接近的若干项（最多 5 项）。
只输出 JSON 数组，按 confidence 从高到低排列。
若无任何可匹配项，输出 []。

【标准问题列表】
q143|光圈优先自动模式（A）如何调整光圈？
q145|手动模式（M）如何调整快门速度和光圈？
q140|程序自动模式（P）如何工作？
q002|快门速度拨盘如何设置快门速度？"""

MESSAGES = [
    ChatMessage(role="system", content=SYSTEM),
    ChatMessage(role="user", content=QUESTION),
]

PROFILE = {
    "api_base_url": "http://127.0.0.1:11434/v1",
    "api_key": "",
    "model": "qwen3.5:2b",
    "max_tokens": 512,
    "temperature": 0.0,
}


def run_once(
    settings: Settings,
    enable_thinking: bool,
    label: str,
    *,
    api_key: str | None = None,
) -> None:
    key = PROFILE["api_key"] if api_key is None else api_key
    llm = LLMClient(
        settings,
        api_base_url=PROFILE["api_base_url"],
        api_key=key,
        enable_thinking=enable_thinking,
    )
    native = llm._use_ollama_native()
    print(f"\n=== {label} (enable_thinking={enable_thinking}, native_api={native}) ===")
    t0 = time.perf_counter()
    first_token: float | None = None
    buffer = ""
    usage = []
    try:
        for delta in llm.chat_stream(
            model=PROFILE["model"],
            messages=MESSAGES,
            max_tokens=PROFILE["max_tokens"],
            temperature=PROFILE["temperature"],
            usage_out=usage,
        ):
            if first_token is None:
                first_token = time.perf_counter() - t0
            buffer += delta
    except Exception as e:
        total = time.perf_counter() - t0
        print(f"ERROR after {total:.2f}s: {type(e).__name__}: {e}")
        return
    total = time.perf_counter() - t0
    u = usage[0].to_dict() if usage else {}
    preview = buffer.strip().replace("\n", " ")[:120]
    ft_ms = first_token * 1000 if first_token is not None else 0
    print(f"首 token: {ft_ms:.0f} ms")
    print(f"总耗时:   {total * 1000:.0f} ms ({total:.2f} s)")
    print(
        f"Tokens:   prompt={u.get('prompt_tokens', '?')} "
        f"completion={u.get('completion_tokens', '?')} "
        f"total={u.get('total_tokens', '?')}"
    )
    print(f"输出预览: {preview!r}")


def main() -> None:
    settings = Settings.load()
    print("Warmup (关闭思考)...")
    run_once(settings, False, "warmup")
    for thinking, label, key in [
        (False, "关闭思考", None),
        (True, "开启思考(OpenAI兼容, key=ollama)", "ollama"),
        (False, "关闭思考(第2次)", None),
    ]:
        run_once(settings, thinking, label, api_key=key)


if __name__ == "__main__":
    main()
