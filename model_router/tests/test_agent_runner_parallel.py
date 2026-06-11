import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runner import run_agents
from app.config import Settings
from app.llm_client import LLMClient
from app.schemas import RouterResult, RouterTargetAgent


def _make_settings(tmp_path: Path) -> Settings:
    data_root = tmp_path / "data_root"
    (data_root / "files" / "agent_a").mkdir(parents=True)
    (data_root / "files" / "agent_b").mkdir(parents=True)
    (data_root / "files" / "agent_c").mkdir(parents=True)
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


def test_run_agents_only_executes_first_target(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _make_settings(tmp_path)
    llm = LLMClient(settings)
    calls: list[str] = []

    def _track_answer(*, model: str, messages, max_tokens=None):
        if model == settings.answer_model:
            sys_text = next((m.content for m in messages if m.role == "system"), "")
            calls.append(str(sys_text)[:20])
            return "一、结论\nmock\n\n二、依据\nmock\n\n三、补充说明\nmock"
        return llm._mock_chat(model=model, messages=messages)

    monkeypatch.setattr(llm, "chat", _track_answer)

    agents = {
        aid: {
            "name": f"Agent {aid}",
            "knowledge": f"关于 test question 的说明\ncontent-{aid}详情",
            "files_dir": f"files/agent_{aid}",
        }
        for aid in ("a", "b", "c")
    }
    route_result = RouterResult(
        target_agents=[
            RouterTargetAgent(agent_id=aid, confidence="high" if aid == "a" else "low")
            for aid in ("a", "b", "c")
        ],
        need_clarification=False,
    )

    answers, merged, illustrations, timings = run_agents(
        question="test question",
        route_result=route_result,
        agents=agents,
        llm=llm,
        settings=settings,
    )

    assert len(answers) == 1
    assert answers[0].agent_id == "a"
    assert merged == answers[0].answer
    assert len(calls) == 1
    assert timings.merge_ms == 0.0
