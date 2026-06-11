import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runner import _fill_illustrations_from_pool, _merge_answers
from app.config import Settings
from app.llm_client import LLMClient
from app.schemas import Citation, PerAgentAnswer, RouterTargetAgent


def _make_settings(tmp_path: Path) -> Settings:
    data_root = tmp_path / "data_root"
    data_root.mkdir(parents=True)
    return Settings(
        api_base_url="https://example.invalid/v1",
        api_key="",
        router_model="router",
        init_model="init",
        answer_model="answer",
        max_file_chars=120000,
        max_tokens=256,
        answer_max_tokens=256,
        max_answer_chars=0,
        use_max_completion_tokens=False,
        mock_llm=True,
        use_content_parts=False,
        enable_thinking=None,
        reasoning_effort=None,
        min_route_questions=1,
        max_route_questions=100,
        max_agent_workers=8,
        data_root=data_root,
        agents_config_path=data_root / "config" / "agents.json",
        files_root=data_root / "files",
    )


def test_single_agent_merge_includes_image_illustrations(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path)
    llm = LLMClient(settings)
    route = RouterTargetAgent(agent_id="4", confidence="high")
    answer = PerAgentAnswer(
        agent_id="4",
        agent_name="agent_4",
        route=route,
        answer="一、结论\nmock\n\n二、依据\nmock\n\n三、补充说明\nmock",
        citations=[
            Citation(
                file="files/assets/p016_figure_clip_001.png",
                page=None,
                snippet="使用照相机在高位拍摄时，将显示屏朝下。",
            )
        ],
    )

    merged, illustrations, merge_ms = _merge_answers([answer], llm=llm, settings=settings)

    assert merged == answer.answer
    assert merge_ms == 0.0
    assert len(illustrations) == 1
    assert illustrations[0].file == "files/assets/p016_figure_clip_001.png"


def test_multi_agent_merge_falls_back_to_image_pool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _make_settings(tmp_path)
    llm = LLMClient(settings)
    route = RouterTargetAgent(agent_id="4", confidence="high")

    def _merge_without_images(*, model: str, messages, max_tokens=None):
        if model == settings.answer_model and "多 agent 回答合并器" in next(
            (m.content for m in messages if m.role == "system"), ""
        ):
            return '{"merged_answer":"一、结论\\n合并\\n\\n二、依据\\n合并\\n\\n三、补充说明\\n合并","illustrations":[]}'
        return llm._mock_chat(model=model, messages=messages)

    monkeypatch.setattr(llm, "chat", _merge_without_images)

    answers = [
        PerAgentAnswer(
            agent_id="4",
            agent_name="agent_4",
            route=route,
            answer="一、结论\na\n\n二、依据\na\n\n三、补充说明\na",
            citations=[
                Citation(
                    file="files/assets/p016_figure_clip_001.png",
                    page=None,
                    snippet="显示屏朝下",
                )
            ],
        ),
        PerAgentAnswer(
            agent_id="5",
            agent_name="agent_5",
            route=route,
            answer="一、结论\nb\n\n二、依据\nb\n\n三、补充说明\nb",
            citations=[],
        ),
    ]

    _, illustrations, _ = _merge_answers(answers, llm=llm, settings=settings)
    assert len(illustrations) == 1
    assert illustrations[0].file == "files/assets/p016_figure_clip_001.png"


def test_fill_illustrations_from_pool() -> None:
    pool = [
        {"file": "files/assets/a.png", "page": None, "snippet": "图A"},
        {"file": "files/assets/b.png", "page": None, "snippet": "图B"},
    ]
    out = _fill_illustrations_from_pool([], pool, max_items=2)
    assert len(out) == 2
    assert out[0].file == "files/assets/a.png"
