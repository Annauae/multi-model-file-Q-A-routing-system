from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

from .config import Settings, settings

_LOCK = threading.Lock()

DEFAULT_TEMPLATES: list[dict[str, str]] = [
    {
        "id": "default",
        "name": "默认严谨模板",
        "content": (
            "你是相机 FAQ 助手。请只根据给定 FAQ 来源回答，不能编造；"
            "如果资料不足，请说明未找到高置信答案。回答使用简体中文。\n\n"
            "用户问题：{query}\n\nFAQ 来源：\n{context}"
        ),
    },
    {
        "id": "concise",
        "name": "简洁模板",
        "content": (
            "请根据以下 FAQ 来源简洁回答用户问题，只输出结论和关键步骤，使用简体中文。\n\n"
            "用户问题：{query}\n\nFAQ 来源：\n{context}"
        ),
    },
    {
        "id": "explain",
        "name": "详细讲解模板",
        "content": (
            "你是耐心的相机使用顾问。请根据 FAQ 来源详细讲解用户问题，"
            "可补充操作步骤和注意事项，但不要编造资料外的信息。使用简体中文。\n\n"
            "用户问题：{query}\n\nFAQ 来源：\n{context}"
        ),
    },
]


@dataclass
class RuntimeConfig:
    temperature: float = 0.1
    top_k: int = 8
    top_n: int = 3
    answer_mode: str = "direct"  # direct | generated
    use_rerank: bool = True
    min_confidence_score: float = 0.05
    active_template_id: str = "default"
    templates: list[dict[str, str]] = field(default_factory=lambda: [dict(t) for t in DEFAULT_TEMPLATES])

    def active_template(self) -> dict[str, str]:
        for tpl in self.templates:
            if tpl.get("id") == self.active_template_id:
                return tpl
        return self.templates[0] if self.templates else DEFAULT_TEMPLATES[0]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _path(cfg: Settings = settings) -> Path:
    return cfg.db_path.parent / "runtime_config.json"


def load_runtime_config(cfg: Settings = settings) -> RuntimeConfig:
    path = _path(cfg)
    if not path.is_file():
        return RuntimeConfig()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return RuntimeConfig()
    templates = data.get("templates") or [dict(t) for t in DEFAULT_TEMPLATES]
    return RuntimeConfig(
        temperature=float(data.get("temperature", 0.1)),
        top_k=int(data.get("top_k", 8)),
        top_n=int(data.get("top_n", 3)),
        answer_mode=str(data.get("answer_mode", "direct")),
        use_rerank=bool(data.get("use_rerank", True)),
        min_confidence_score=float(data.get("min_confidence_score", 0.05)),
        active_template_id=str(data.get("active_template_id", "default")),
        templates=templates,
    )


def save_runtime_config(rc: RuntimeConfig, cfg: Settings = settings) -> None:
    with _LOCK:
        _path(cfg).parent.mkdir(parents=True, exist_ok=True)
        _path(cfg).write_text(
            json.dumps(rc.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def update_runtime_config(patch: dict[str, Any], cfg: Settings = settings) -> RuntimeConfig:
    rc = load_runtime_config(cfg)
    if "temperature" in patch:
        rc.temperature = max(0.0, min(2.0, float(patch["temperature"])))
    if "top_k" in patch:
        rc.top_k = max(1, min(50, int(patch["top_k"])))
    if "top_n" in patch:
        rc.top_n = max(1, min(10, int(patch["top_n"])))
    if "answer_mode" in patch and patch["answer_mode"] in {"direct", "generated"}:
        rc.answer_mode = patch["answer_mode"]
    if "use_rerank" in patch:
        rc.use_rerank = bool(patch["use_rerank"])
    if "min_confidence_score" in patch:
        rc.min_confidence_score = max(0.0, min(1.0, float(patch["min_confidence_score"])))
    if "active_template_id" in patch:
        rc.active_template_id = str(patch["active_template_id"])
    if "templates" in patch and isinstance(patch["templates"], list):
        rc.templates = [
            {"id": str(t.get("id")), "name": str(t.get("name", "")), "content": str(t.get("content", ""))}
            for t in patch["templates"]
            if t.get("id")
        ]
    save_runtime_config(rc, cfg)
    return rc
