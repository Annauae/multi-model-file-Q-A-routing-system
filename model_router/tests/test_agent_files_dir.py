import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.paths import agent_files_dir
from app.knowledge_loader import legacy_agent_files_dir, resolve_agent_knowledge


def test_agent_files_dir_is_canonical() -> None:
    assert agent_files_dir("1", "2") == "files/router_1/agent_2"
    assert agent_files_dir("3", "finance_agent") == "files/router_3/agent_finance_agent"


def test_resolve_agent_knowledge_uses_files_dir(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent2_dir = data_root / "files" / "router_1" / "agent_2"
    agent1_dir = data_root / "files" / "router_1" / "agent_1"
    agent2_dir.mkdir(parents=True)
    agent1_dir.mkdir(parents=True)
    (agent2_dir / "knowledge.md").write_text("agent 2 knowledge", encoding="utf-8")
    (agent1_dir / "knowledge.md").write_text("agent 1 knowledge", encoding="utf-8")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="2",
        files_dir=agent_files_dir("1", "2"),
        configured_knowledge="",
        max_chars=10000,
        require_file_knowledge=True,
    )
    assert "agent 2 knowledge" in text
    assert "agent_2" in source

    text_legacy, _, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="2",
        files_dir="",
        configured_knowledge="",
        max_chars=10000,
        require_file_knowledge=True,
    )
    # Without files_dir falls back to legacy flat path (may be empty)
    assert text_legacy == "" or "agent 2" in text_legacy


def test_agents_store_files_dir_normalization(tmp_path: Path) -> None:
    from app.agents_store import AgentsStore

    store_path = tmp_path / "files" / "router_1" / "agents.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text('{"1": {"name": "a", "files_dir": "files/agent_1"}}', encoding="utf-8")
    store = AgentsStore.open(store_path, router_id="1")
    cfg = store.get("1")
    assert cfg is not None
    assert cfg["files_dir"] == "files/router_1/agent_1"
