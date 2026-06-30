from __future__ import annotations

from knowledge_router.app.config import Settings
from knowledge_router.app.llm_client import LLMClient
from knowledge_router.app.models_store import parse_enable_thinking


def test_parse_enable_thinking() -> None:
    assert parse_enable_thinking(None) is None
    assert parse_enable_thinking(True) is True
    assert parse_enable_thinking(False) is False
    assert parse_enable_thinking("false") is False
    assert parse_enable_thinking("true") is True
    assert parse_enable_thinking("invalid") is None


def test_ollama_native_when_profile_disables_thinking(monkeypatch) -> None:
    monkeypatch.setenv("ENABLE_THINKING", "1")
    settings = Settings.load()
    assert settings.enable_thinking is True

    llm = LLMClient(settings, api_base_url="http://127.0.0.1:11434/v1", api_key="", enable_thinking=False)
    assert llm._use_ollama_native() is True

    cloud = LLMClient(settings, api_base_url="https://api.example.com/v1", api_key="k", enable_thinking=False)
    assert cloud._use_ollama_native() is False
