from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from knowledge_router.app.config import Settings
from knowledge_router.app.main import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    config_path = tmp_path / "config" / "knowledge_bases.json"
    files_root = tmp_path / "files"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        '{"1":{"name":"测试","match_prompt":"","status":"ready","created_at":"2026-06-23T00:00:00Z","updated_at":"2026-06-23T00:00:00Z"}}',
        encoding="utf-8",
    )
    qdir = files_root / "kb_1"
    qdir.mkdir(parents=True)
    (qdir / "questions.json").write_text(
        '{"version":1,"items":[{"id":"q001","question":"曝光补偿怎么用？","variants":[],"answer":"预存回答内容","enabled":true,"updated_at":"2026-06-23T00:00:00Z"}]}',
        encoding="utf-8",
    )
    monkeypatch.setenv("DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("FILES_ROOT", str(files_root))
    monkeypatch.setenv("MOCK_LLM", "1")
    monkeypatch.setenv("API_KEY", "test")
    app = create_app()
    with TestClient(app) as c:
        yield c


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_ask_returns_cached_answer(client: TestClient) -> None:
    resp = client.post("/ask", json={"question": "曝光补偿", "kb_id": "1"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["answer"] == "预存回答内容"
    assert data["match"]["matched_id"] == "q001"
    assert data["timings"]["lookup_ms"] >= 0


def test_ask_clarification(client: TestClient) -> None:
    resp = client.post("/ask", json={"question": "完全无关的问题不知道", "kb_id": "1"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["match"]["need_clarification"] is True
    assert data["answer"] == ""


def test_list_knowledge_bases(client: TestClient) -> None:
    resp = client.get("/knowledge-bases")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert any(x["kb_id"] == "1" for x in items)


def test_ask_stream_done(client: TestClient) -> None:
    with client.stream("POST", "/ask/stream", json={"question": "曝光补偿", "kb_id": "1"}) as resp:
        assert resp.status_code == 200
        body = resp.read().decode("utf-8")
    assert "event: done" in body
    assert "预存回答内容" in body
