import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def admin_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("MOCK_LLM", "1")
    monkeypatch.setenv("API_BASE_URL", "https://example.invalid/v1")
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.setenv("ROUTER_MODEL", "router-mock-model")
    monkeypatch.setenv("INIT_MODEL", "init-mock-model")
    monkeypatch.setenv("ANSWER_MODEL", "answer-mock-model")

    data_root = tmp_path / "data_root"
    (data_root / "config").mkdir(parents=True, exist_ok=True)
    (data_root / "files").mkdir(parents=True, exist_ok=True)
    (data_root / "config" / "agents.json").write_text("{}", encoding="utf-8")
    (data_root / "config" / "routers.json").write_text(
        json.dumps(
            {
                "1": {
                    "name": "总Agent_1",
                    "router_prompt": "",
                    "status": "initialized",
                    "agent_ids": [],
                    "source_files": [],
                    "split_ranges": [],
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    from app.main import create_app

    return TestClient(create_app())


def test_create_agent_auto(admin_client: TestClient) -> None:
    resp = admin_client.post("/agents/auto?router_id=1")
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == "1"
    assert data["name"] == "agent_1"
    knowledge = admin_client.app.state.settings.files_root / "router_1" / "agent_1" / "knowledge.md"
    assert knowledge.is_file()


def test_create_agent_auto_assigns_smallest_id(admin_client: TestClient) -> None:
    admin_client.post("/agents/auto?router_id=1")
    r2 = admin_client.post("/agents/auto?router_id=1")
    assert r2.json()["agent_id"] == "2"


def test_rename_agent(admin_client: TestClient) -> None:
    admin_client.post("/agents/auto?router_id=1")
    files_root = admin_client.app.state.settings.files_root
    assert (files_root / "router_1" / "agent_1" / "knowledge.md").is_file()

    resp = admin_client.post("/agents/1/rename?router_id=1", json={"new_agent_id": "9"})
    assert resp.status_code == 200
    assert resp.json()["agent_id"] == "9"
    assert not (files_root / "router_1" / "agent_1").exists()
    assert (files_root / "router_1" / "agent_9" / "knowledge.md").is_file()

    agents = admin_client.get("/agents").json()["agents"]
    assert "9" in agents
    assert "1" not in agents


def test_rename_agent_display(admin_client: TestClient) -> None:
    admin_client.post("/agents/auto?router_id=1")
    resp = admin_client.post(
        "/agents/1/rename-display?router_id=1",
        json={"name": "相机模块"},
    )
    assert resp.status_code == 200
    assert resp.json()["agent"]["name"] == "相机模块"
    agents = admin_client.get("/agents").json()["agents"]
    assert agents["1"]["name"] == "相机模块"


def test_delete_agent(admin_client: TestClient) -> None:
    admin_client.post("/agents/auto?router_id=1")
    files_root = admin_client.app.state.settings.files_root
    agent_dir = files_root / "router_1" / "agent_1"
    assert agent_dir.is_dir()

    resp = admin_client.delete("/agents/1?router_id=1")
    assert resp.status_code == 200
    assert not agent_dir.exists()
    assert "1" not in admin_client.get("/agents").json()["agents"]
