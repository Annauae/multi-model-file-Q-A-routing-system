from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dependency is in requirements
    load_dotenv = None


ROOT_DIR = Path(__file__).resolve().parents[1]

if load_dotenv is not None:
    env_path = ROOT_DIR / ".env"
    if env_path.is_file():
        load_dotenv(env_path)


def _bool_env(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: str) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return int(default)


def _float_env(name: str, default: str) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


def _path_env(name: str, default: str) -> Path:
    raw = Path(os.environ.get(name, default))
    return raw if raw.is_absolute() else ROOT_DIR / raw


@dataclass(frozen=True)
class Settings:
    root_dir: Path = ROOT_DIR
    data_path: Path = _path_env("DATA_PATH", "data/questions.json")
    assets_dir: Path = _path_env("ASSETS_DIR", "data/assets")
    db_path: Path = _path_env("DB_PATH", "data/faq.db")
    vector_dir: Path = _path_env("VECTOR_DIR", "data/indexes")

    siliconflow_api_key: str = os.environ.get("SILICONFLOW_API_KEY", "")
    siliconflow_base_url: str = os.environ.get(
        "SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1"
    ).rstrip("/")
    embedding_model: str = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3")
    rerank_model: str = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
    llm_model: str = os.environ.get("LLM_MODEL", "Qwen/Qwen3-VL-8B-Instruct")
    judge_model: str = os.environ.get("JUDGE_MODEL", "Qwen/Qwen3-VL-8B-Instruct")

    use_api_embedding: bool = _bool_env("USE_API_EMBEDDING", "1")
    use_rerank: bool = _bool_env("USE_RERANK", "1")
    use_llm_answer: bool = _bool_env("USE_LLM_ANSWER", "0")
    answer_mode: str = os.environ.get("ANSWER_MODE", "direct").strip().lower()

    embedding_batch_size: int = _int_env("EMBEDDING_BATCH_SIZE", "16")
    embedding_sleep_sec: float = _float_env("EMBEDDING_SLEEP_SEC", "0.25")
    embedding_max_chars: int = _int_env("EMBEDDING_MAX_CHARS", "6000")
    hash_embedding_dim: int = _int_env("HASH_EMBEDDING_DIM", "1024")

    vector_top_k: int = _int_env("VECTOR_TOP_K", "30")
    keyword_top_k: int = _int_env("KEYWORD_TOP_K", "30")
    rrf_k: int = _int_env("RRF_K", "60")
    rerank_top_n: int = _int_env("RERANK_TOP_N", "8")
    answer_top_n: int = _int_env("ANSWER_TOP_N", "3")
    min_confidence_score: float = _float_env("MIN_CONFIDENCE_SCORE", "0.05")

    eval_holdout_per_item: int = _int_env("EVAL_HOLDOUT_PER_ITEM", "1")
    eval_default_top_k: int = _int_env("EVAL_DEFAULT_TOP_K", "5")
    eval_max_workers: int = _int_env("EVAL_MAX_WORKERS", "1")

    @property
    def has_api_key(self) -> bool:
        return bool(self.siliconflow_api_key.strip())


settings = Settings()


def ensure_runtime_dirs(cfg: Settings = settings) -> None:
    cfg.assets_dir.mkdir(parents=True, exist_ok=True)
    cfg.db_path.parent.mkdir(parents=True, exist_ok=True)
    cfg.vector_dir.mkdir(parents=True, exist_ok=True)
