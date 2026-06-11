import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def files_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("MOCK_LLM", "1")
    monkeypatch.setenv("API_BASE_URL", "https://example.invalid/v1")
    monkeypatch.delenv("API_KEY", raising=False)

    data_root = tmp_path / "data_root"
    files_root = data_root / "files"
    (data_root / "config").mkdir(parents=True, exist_ok=True)
    (files_root / "agent_1").mkdir(parents=True)
    (files_root / "agent_1" / "knowledge.md").write_text("hello", encoding="utf-8")
    (files_root / "assets").mkdir(parents=True)
    (data_root / "config" / "agents.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    from app.main import create_app

    return TestClient(create_app())


def test_files_tree(files_client: TestClient) -> None:
    resp = files_client.get("/files/tree", params={"root": "files"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["root"] == "files"
    names = {n["name"] for n in data["tree"]}
    assert "agent_1" in names
    assert "assets" in names


def test_write_and_read_raw(files_client: TestClient) -> None:
    path = "files/agent_1/knowledge.md"
    resp = files_client.put("/files/raw", json={"file": path, "text": "updated content"})
    assert resp.status_code == 200
    assert resp.json()["char_count"] == len("updated content")

    read = files_client.get("/files/raw", params={"file": path})
    assert read.status_code == 200
    assert read.json()["text"] == "updated content"


def test_create_and_delete_file(files_client: TestClient) -> None:
    path = "files/agent_1/notes.md"
    create = files_client.post("/files", json={"file": path})
    assert create.status_code == 200

    delete = files_client.delete("/files", params={"file": path})
    assert delete.status_code == 200


def test_rename_file(files_client: TestClient) -> None:
    src = "files/agent_1/knowledge.md"
    dst = "files/agent_1/knowledge_renamed.md"
    resp = files_client.post("/files/rename", json={"from": src, "to": dst})
    assert resp.status_code == 200
    assert files_client.get("/files/raw", params={"file": dst}).status_code == 200


def test_path_outside_files_forbidden(files_client: TestClient) -> None:
    resp = files_client.put("/files/raw", json={"file": "etc/passwd", "text": "x"})
    assert resp.status_code == 403
