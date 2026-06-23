"""
config.py — 环境变量与全局 Settings

职责：
  - 从 knowledge_router/.env 加载配置（与 model_router 共用同一套变量名）
  - 匹配模型：优先 MATCH_MODEL，否则回退 ROUTER_MODEL
  - 路径：data_root、files_root、kb_config_path（knowledge_bases.json）

使用方式：
  settings = Settings.load()
  在 create_app() 启动时加载一次，挂到 app.state.settings

阅读顺序：第 2 个（依赖 paths 概念，但不 import paths）
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


def _project_root() -> Path:
    """knowledge_router/ 项目根目录（app 的上一级）。"""
    return Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    """不可变配置快照；frozen 防止运行中被意外修改。"""

    api_base_url: str          # OpenAI 兼容 API 地址（如 OpenRouter）
    api_key: str               # 鉴权密钥
    match_model: str           # 匹配模型名（语义选 FAQ 条目）
    max_tokens: int            # 单次 LLM 调用 token 上限
    use_max_completion_tokens: bool  # 部分网关用 max_completion_tokens 而非 max_tokens
    mock_llm: bool             # True 时不调真实 API，返回固定 mock JSON（测试用）
    use_content_parts: bool    # 是否将 user 消息包装为 [{type,text}] 结构
    enable_thinking: Optional[bool]  # 部分模型思考链开关
    reasoning_effort: Optional[str]  # low/medium/high
    llm_temperature: float     # 采样温度，默认 0 最确定
    data_root: Path            # 数据根目录，默认等于项目根
    kb_config_path: Path       # config/knowledge_bases.json
    files_root: Path           # files/ 目录，存放各 kb_{id}

    @staticmethod
    def load() -> "Settings":
        """读取 .env 并构造 Settings；override=True 确保 .env 覆盖系统环境变量。"""
        app_root = _project_root()
        load_dotenv(app_root / ".env", override=True)

        api_base_url = os.getenv("API_BASE_URL", "https://api.openai.com/v1").strip()
        api_key = (os.getenv("API_KEY", "") or os.getenv("ARK_API_KEY", "")).strip()
        # 与 model_router 共用 .env：未设 MATCH_MODEL 时回退 ROUTER_MODEL
        match_model = (
            os.getenv("MATCH_MODEL", "").strip()
            or os.getenv("ROUTER_MODEL", "").strip()
            or "gpt-4.1-mini"
        )
        max_tokens = int(os.getenv("MAX_TOKENS", "4096"))
        use_max_completion_tokens = os.getenv("USE_MAX_COMPLETION_TOKENS", "0").strip() in {
            "1", "true", "True", "YES", "yes",
        }
        mock_llm = os.getenv("MOCK_LLM", "0").strip() in {"1", "true", "True", "YES", "yes"}
        use_content_parts = os.getenv("USE_CONTENT_PARTS", "0").strip() in {"1", "true", "True", "YES", "yes"}
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
        llm_temperature = float(os.getenv("LLM_TEMPERATURE", "0"))

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
            use_max_completion_tokens=use_max_completion_tokens,
            mock_llm=mock_llm,
            use_content_parts=use_content_parts,
            enable_thinking=enable_thinking,
            reasoning_effort=reasoning_effort,
            llm_temperature=max(0.0, min(2.0, llm_temperature)),
            data_root=data_root,
            kb_config_path=kb_config_path,
            files_root=files_root,
        )


# 模块级常量：web 静态资源、index.html 等路径解析用
APP_ROOT = _project_root()
