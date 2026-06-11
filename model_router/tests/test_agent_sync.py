import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_sync import sync_agent_from_files
from app.agents_store import AgentsStore


def test_sync_agent_reset_when_folder_empty(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    (data_root / "files" / "agent_12").mkdir(parents=True)
    store_path = data_root / "config" / "agents.json"
    store = AgentsStore.open(store_path)
    store.create_agent(agent_id="12", name="agent_12")
    store.set_knowledge(agent_id="12", knowledge="stale cached knowledge")
    store.update_initialized(
        agent_id="12",
        files=["knowledge"],
        route_questions=["旧问题"],
        file_summaries=[{"file": "knowledge", "summary": "旧摘要"}],
    )

    result = sync_agent_from_files(
        store=store,
        project_root=data_root,
        agent_id="12",
        max_chars=10000,
    )

    assert result == "reset"
    cfg = store.get("12")
    assert cfg is not None
    assert cfg["status"] == "created"
    assert cfg["knowledge"] == ""
    assert cfg["route_questions"] == []
    assert cfg["file_summaries"] == []


def test_sync_agent_stages_when_file_exists(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_1"
    agent_dir.mkdir(parents=True)
    (agent_dir / "knowledge.md").write_text("new file knowledge", encoding="utf-8")
    store_path = data_root / "config" / "agents.json"
    store = AgentsStore.open(store_path)
    store.create_agent(agent_id="1", name="agent_1")
    store.set_knowledge(agent_id="1", knowledge="old json knowledge")
    store.update_initialized(
        agent_id="1",
        files=["knowledge"],
        route_questions=["旧问题"],
        file_summaries=[{"file": "knowledge", "summary": "旧摘要"}],
    )

    result = sync_agent_from_files(
        store=store,
        project_root=data_root,
        agent_id="1",
        max_chars=10000,
    )

    assert result == "staged"
    cfg = store.get("1")
    assert cfg is not None
    assert cfg["knowledge"] == "new file knowledge"
    assert cfg["status"] == "created"
    assert cfg["route_questions"] == []
