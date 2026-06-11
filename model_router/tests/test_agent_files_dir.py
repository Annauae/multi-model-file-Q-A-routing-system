import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agents_store import AgentsStore
from app.knowledge_loader import agent_files_dir, resolve_agent_knowledge


def test_agent_files_dir_is_canonical() -> None:
    assert agent_files_dir("2") == "files/agent_2"
    assert agent_files_dir("finance_agent") == "files/agent_finance_agent"


def test_resolve_agent_knowledge_ignores_custom_files_dir(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent2_dir = data_root / "files" / "agent_2"
    agent1_dir = data_root / "files" / "agent_1"
    agent2_dir.mkdir(parents=True)
    agent1_dir.mkdir(parents=True)
    (agent2_dir / "knowledge.md").write_text("agent 2 knowledge", encoding="utf-8")
    (agent1_dir / "knowledge.md").write_text("agent 1 knowledge", encoding="utf-8")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="2",
        files_dir="files/agent_1",
        configured_knowledge="",
        max_chars=10000,
        require_file_knowledge=True,
    )

    assert text == "agent 2 knowledge"
    assert source == "files/agent_2/knowledge.md"


def test_agents_store_normalizes_files_dir_on_open(tmp_path: Path) -> None:
    store_path = tmp_path / "agents.json"
    store_path.write_text(
        '{"2": {"name": "agent_2", "files_dir": "files/agent_1", "status": "created"}}',
        encoding="utf-8",
    )
    store = AgentsStore.open(store_path)
    cfg = store.get("2")
    assert cfg is not None
    assert cfg["files_dir"] == "files/agent_2"
    assert '"files/agent_2"' in store_path.read_text(encoding="utf-8")
