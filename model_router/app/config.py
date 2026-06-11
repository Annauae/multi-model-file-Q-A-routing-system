from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


def _project_root() -> Path:
    # model_router/app/config.py -> model_router/
    return Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    api_key: str
    router_model: str
    init_model: str
    answer_model: str
    max_file_chars: int
    max_tokens: int
    answer_max_tokens: int
    max_answer_chars: int
    use_max_completion_tokens: bool
    mock_llm: bool
    use_content_parts: bool
    answer_with_images: bool
    max_answer_images: int
    enable_thinking: Optional[bool]
    reasoning_effort: Optional[str]
    min_route_questions: int
    max_route_questions: int
    max_agent_workers: int
    data_root: Path
    agents_config_path: Path
    batch_tests_config_path: Path
    files_root: Path

    @staticmethod
    def load() -> "Settings":
        # Load .env from app root if present
        app_root = _project_root()
        load_dotenv(app_root / ".env", override=True)

        api_base_url = os.getenv("API_BASE_URL", "https://api.openai.com/v1").strip()
        # Prefer API_KEY from .env; ARK_API_KEY is only a fallback (avoid stale system env overriding .env).
        api_key = (os.getenv("API_KEY", "") or os.getenv("ARK_API_KEY", "")).strip()
        router_model = os.getenv("ROUTER_MODEL", "gpt-4.1-mini").strip()
        answer_model = os.getenv("ANSWER_MODEL", "gpt-4.1").strip()
        init_model = os.getenv("INIT_MODEL", "").strip() or answer_model

        max_file_chars = int(os.getenv("MAX_FILE_CHARS", "120000"))
        max_tokens = int(os.getenv("MAX_TOKENS", "4096"))
        answer_max_tokens = int(os.getenv("ANSWER_MAX_TOKENS", "512"))
        max_answer_chars = int(os.getenv("MAX_ANSWER_CHARS", "0"))
        use_max_completion_tokens = os.getenv("USE_MAX_COMPLETION_TOKENS", "0").strip() in {"1", "true", "True", "YES", "yes"}
        mock_llm = os.getenv("MOCK_LLM", "0").strip() in {"1", "true", "True", "YES", "yes"}
        use_content_parts = os.getenv("USE_CONTENT_PARTS", "0").strip() in {"1", "true", "True", "YES", "yes"}
        answer_with_images = os.getenv("ANSWER_WITH_IMAGES", "1").strip() in {"1", "true", "True", "YES", "yes"}
        max_answer_images = int(os.getenv("MAX_ANSWER_IMAGES", "0"))
        enable_thinking_raw = os.getenv("ENABLE_THINKING", "").strip().lower()
        disable_thinking = os.getenv("DISABLE_THINKING", "1").strip() in {"1", "true", "True", "YES", "yes"}
        enable_thinking: Optional[bool]
        if enable_thinking_raw in {"1", "true", "yes"}:
            enable_thinking = True
        elif enable_thinking_raw in {"0", "false", "no"}:
            enable_thinking = False
        elif disable_thinking:
            enable_thinking = False
        else:
            enable_thinking = None
        reasoning_effort_raw = os.getenv("REASONING_EFFORT", "").strip().lower()
        reasoning_effort = reasoning_effort_raw if reasoning_effort_raw in {"low", "medium", "high"} else None
        min_route_questions = int(os.getenv("MIN_ROUTE_QUESTIONS", "50"))
        max_route_questions = int(os.getenv("MAX_ROUTE_QUESTIONS", "100"))
        max_agent_workers = int(os.getenv("AGENT_MAX_WORKERS", "8"))

        data_root = Path(os.getenv("DATA_ROOT", str(app_root))).resolve()
        agents_config_path = Path(os.getenv("AGENTS_CONFIG_PATH", str(data_root / "config" / "agents.json"))).resolve()
        batch_tests_config_path = Path(
            os.getenv("BATCH_TESTS_CONFIG_PATH", str(data_root / "config" / "batch_tests.json"))
        ).resolve()
        files_root = Path(os.getenv("FILES_ROOT", str(data_root / "files"))).resolve()

        return Settings(
            api_base_url=api_base_url,
            api_key=api_key,
            router_model=router_model,
            init_model=init_model,
            answer_model=answer_model,
            max_file_chars=max_file_chars,
            max_tokens=max_tokens,
            answer_max_tokens=max(64, answer_max_tokens),
            max_answer_chars=max(0, max_answer_chars),
            use_max_completion_tokens=use_max_completion_tokens,
            mock_llm=mock_llm,
            use_content_parts=use_content_parts,
            answer_with_images=answer_with_images,
            max_answer_images=max(0, max_answer_images),
            enable_thinking=enable_thinking,
            reasoning_effort=reasoning_effort,
            min_route_questions=min_route_questions,
            max_route_questions=max_route_questions,
            max_agent_workers=max(1, max_agent_workers),
            data_root=data_root,
            agents_config_path=agents_config_path,
            batch_tests_config_path=batch_tests_config_path,
            files_root=files_root,
        )


APP_ROOT = _project_root()
