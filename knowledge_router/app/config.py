from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    api_key: str
    match_model: str
    max_tokens: int
    match_max_tokens: int
    match_temperature: float
    use_max_completion_tokens: bool
    mock_llm: bool
    use_content_parts: bool
    enable_thinking: bool | None
    reasoning_effort: str | None
    data_root: Path
    kb_config_path: Path
    files_root: Path

    @staticmethod
    def load() -> "Settings":
        app_root = _project_root()
        load_dotenv(app_root / ".env", override=False)

        api_base_url = os.getenv("API_BASE_URL", "https://api.openai.com/v1").strip()
        api_key = (os.getenv("API_KEY", "") or os.getenv("ARK_API_KEY", "")).strip()
        match_model = os.getenv("MATCH_MODEL", "gpt-4.1-mini").strip()
        max_tokens = int(os.getenv("MAX_TOKENS", "4096"))
        match_max_tokens = max(16, int(os.getenv("MATCH_MAX_TOKENS", "8")))
        match_temperature = float(os.getenv("MATCH_TEMPERATURE", "0"))
        use_max_completion_tokens = os.getenv("USE_MAX_COMPLETION_TOKENS", "0").strip() in {
            "1",
            "true",
            "True",
            "YES",
            "yes",
        }
        mock_llm = os.getenv("MOCK_LLM", "0").strip() in {"1", "true", "True", "YES", "yes"}
        use_content_parts = os.getenv("USE_CONTENT_PARTS", "0").strip() in {"1", "true", "True", "YES", "yes"}

        enable_thinking_raw = os.getenv("ENABLE_THINKING", "").strip().lower()
        disable_thinking = os.getenv("DISABLE_THINKING", "1").strip() in {"1", "true", "True", "YES", "yes"}
        enable_thinking: bool | None
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

        data_root = Path(os.getenv("DATA_ROOT", str(app_root))).resolve()
        kb_config_path = Path(
            os.getenv("KB_CONFIG_PATH", str(data_root / "config" / "knowledge_bases.json"))
        ).resolve()
        files_root = Path(os.getenv("FILES_ROOT", str(data_root / "files"))).resolve()

        return Settings(
            api_base_url=api_base_url,
            api_key=api_key,
            match_model=match_model,
            max_tokens=max_tokens,
            match_max_tokens=match_max_tokens,
            match_temperature=max(0.0, min(2.0, match_temperature)),
            use_max_completion_tokens=use_max_completion_tokens,
            mock_llm=mock_llm,
            use_content_parts=use_content_parts,
            enable_thinking=enable_thinking,
            reasoning_effort=reasoning_effort,
            data_root=data_root,
            kb_config_path=kb_config_path,
            files_root=files_root,
        )


APP_ROOT = _project_root()
