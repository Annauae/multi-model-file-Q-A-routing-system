from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MOCK_LLM", "1")
os.environ.setdefault("DATA_ROOT", str(Path(__file__).resolve().parents[1]))

from app.main import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "kr"
    files_root = root / "files"
    config_dir = root / "config"
    config_dir.mkdir(parents=True)
    kb_config = config_dir / "knowledge_bases.json"
    kb_config.write_text(
        '{"1":{"name":"T","match_prompt":"","status":"ready","created_at":"","updated_at":""}}',
        encoding="utf-8",
    )
    kb_dir = files_root / "kb_1"
    kb_dir.mkdir(parents=True)
    (kb_dir / "questions.json").write_text(
        """{
  "version": 1,
  "items": [
    {"id":"q001","question":"测试问题?","variants":[],"answer":"测试回答","enabled":true}
  ]
}""",
        encoding="utf-8",
    )
    monkeypatch.setenv("DATA_ROOT", str(root))
    monkeypatch.setenv("FILES_ROOT", str(files_root))
    monkeypatch.setenv("KB_CONFIG_PATH", str(kb_config))
    monkeypatch.setenv("MOCK_LLM", "1")
    app = create_app()
    with TestClient(app) as c:
        yield c


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_ask_returns_stored_answer(client: TestClient) -> None:
    r = client.post("/ask", json={"question": "任意问题", "kb_id": "1"})
    assert r.status_code == 200
    data = r.json()
    assert data["answer"] == "测试回答"
    assert data["match"]["matched_id"] == "q001"
    assert data["cache_hit"] is True
    assert data["timings"]["lookup_ms"] >= 0
