"""应用配置：从 .env 与环境变量加载 Settings。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def _project_root() -> Path:
    """knowledge_router 包根目录（含 app/、web/、.env）。"""
    return Path(__file__).resolve().parents[1]


def _first_env(*keys: str, default: str = "") -> str:
    """按 keys 顺序取第一个非空环境变量，用于模型名等多别名兼容。"""
    for key in keys:
        val = os.getenv(key, "").strip()
        if val:
            return val
    return default


@dataclass(frozen=True)
class Settings:
    """全局不可变配置，由 Settings.load() 构造。"""

    api_base_url: str  # OpenAI 兼容 API 地址
    api_key: str  # 鉴权密钥（API_KEY 或 ARK_API_KEY）
    match_model: str  # 问题匹配所用模型
    import_model: str  # 离线导入 FAQ 所用模型
    max_tokens: int  # 通用 completion 上限
    match_max_tokens: int  # 单 id 匹配输出很短，默认 8
    confidence_max_tokens: int  # 置信度 JSON 数组需要更长输出
    confidence_top_k: int  # 默认 Top-K 候选数（1~20）
    match_temperature: float  # 匹配温度，默认 0 求确定性
    use_max_completion_tokens: bool  # 部分厂商用 max_completion_tokens 替代 max_tokens
    mock_llm: bool  # True 时不调真实 API，用本地启发式 mock
    use_content_parts: bool  # user 消息是否包装为 content parts 数组
    enable_thinking: bool | None  # 推理模型 thinking 开关（None=不传）
    reasoning_effort: str | None  # low/medium/high，None=不传
    data_root: Path  # 数据根目录
    kb_config_path: Path  # knowledge_bases.json 路径
    files_root: Path  # 各 kb 的 files/kb_* 父目录

    @staticmethod
    def load() -> "Settings":
        """读取 .env 与环境变量，组装 Settings。服务启动时调用一次。"""
        app_root = _project_root()
        load_dotenv(app_root / ".env", override=False)  # 不覆盖已存在的系统环境变量

        api_base_url = os.getenv("API_BASE_URL", "https://api.openai.com/v1").strip()
        api_key = (os.getenv("API_KEY", "") or os.getenv("ARK_API_KEY", "")).strip()
        match_model = _first_env("MATCH_MODEL", "INIT_MODEL", "ANSWER_MODEL", default="gpt-4.1-mini")
        import_model = _first_env("IMPORT_MODEL", "INIT_MODEL", "MATCH_MODEL", default=match_model)
        max_tokens = int(os.getenv("MAX_TOKENS", "4096"))
        match_max_tokens = max(16, int(os.getenv("MATCH_MAX_TOKENS", "8")))
        confidence_max_tokens = max(64, int(os.getenv("CONFIDENCE_MAX_TOKENS", "512")))
        confidence_top_k = max(1, min(20, int(os.getenv("CONFIDENCE_TOP_K", "5"))))
        temp_raw = _first_env("MATCH_TEMPERATURE", "LLM_TEMPERATURE", default="0")
        match_temperature = float(temp_raw)
        use_max_completion_tokens = os.getenv("USE_MAX_COMPLETION_TOKENS", "0").strip() in {
            "1",
            "true",
            "True",
            "YES",
            "yes",
        }
        mock_llm = os.getenv("MOCK_LLM", "0").strip() in {"1", "true", "True", "YES", "yes"}
        use_content_parts = os.getenv("USE_CONTENT_PARTS", "0").strip() in {"1", "true", "True", "YES", "yes"}

        # thinking：显式 ENABLE_THINKING 优先；否则 DISABLE_THINKING=1 时关闭
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
            import_model=import_model,
            max_tokens=max_tokens,
            match_max_tokens=match_max_tokens,
            confidence_max_tokens=confidence_max_tokens,
            confidence_top_k=confidence_top_k,
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
