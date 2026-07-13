from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


def _pdf_extract_root() -> Path:
    # Router/server/pdf_extract/app/config.py -> pdf_extract/
    return Path(__file__).resolve().parents[1]


def _router_root() -> Path:
    # Router/server/pdf_extract/app/config.py -> Router/
    return Path(__file__).resolve().parents[3]


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
    llm_temperature: float
    data_root: Path
    agents_config_path: Path
    routers_config_path: Path
    batch_tests_config_path: Path
    files_root: Path

    @staticmethod
    def load() -> "Settings":
        router_root = _router_root()
        load_dotenv(router_root / ".env", override=True)

        def first_env(*keys: str, default: str = "") -> str:
            for key in keys:
                val = (os.getenv(key) or "").strip()
                if val:
                    return val
            return default

        api_base_url = first_env("API_BASE_URL", default="https://api.openai.com/v1")
        api_key = first_env("API_KEY", "ARK_API_KEY")
        answer_model = first_env("ANSWER_MODEL", "MATCH_MODEL", "RAG_LLM_MODEL", default="gpt-4.1-mini")
        init_model = first_env("INIT_MODEL") or answer_model
        router_model = first_env("ROUTER_MODEL", default="gpt-4.1-mini")

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
        min_route_questions = int(os.getenv("MIN_ROUTE_QUESTIONS", "10"))
        max_route_questions = int(os.getenv("MAX_ROUTE_QUESTIONS", "15"))
        max_agent_workers = int(os.getenv("AGENT_MAX_WORKERS", "8"))
        llm_temperature = float(os.getenv("LLM_TEMPERATURE", os.getenv("MATCH_TEMPERATURE", "0")))

        data_root = Path(os.getenv("DATA_ROOT", str(router_root))).resolve()
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
            llm_temperature=max(0.0, min(2.0, llm_temperature)),
            data_root=data_root,
            agents_config_path=(data_root / "config" / "agents.json").resolve(),
            routers_config_path=(data_root / "config" / "routers.json").resolve(),
            batch_tests_config_path=(data_root / "config" / "batch_tests.json").resolve(),
            files_root=files_root,
        )


APP_ROOT = _pdf_extract_root()
