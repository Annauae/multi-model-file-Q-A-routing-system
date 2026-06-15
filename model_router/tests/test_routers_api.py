"""Tests for routers API."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import create_app


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    data_root = tmp_path / "mr"
    data_root.mkdir()
    (data_root / "config").mkdir()
    (data_root / "files").mkdir()
    (data_root / "config" / "agents.json").write_text("{}", encoding="utf-8")
    (data_root / "config" / "routers.json").write_text("{}", encoding="utf-8")
    (data_root / "config" / "batch_tests.json").write_text(json.dumps({"items": []}), encoding="utf-8")
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    monkeypatch.setenv("MOCK_LLM", "1")
    monkeypatch.setenv("ROUTER_MODEL", "router-mock")
    monkeypatch.setenv("ANSWER_MODEL", "answer-mock")
    return TestClient(create_app())


def test_routers_crud(client: TestClient) -> None:
    r = client.post("/routers", json={"name": "总Agent_测试"})
    assert r.status_code == 200
    body = r.json()
    router_id = body["router_id"]
    assert body["router"]["name"] == "总Agent_测试"

    r2 = client.get("/routers")
    assert router_id in r2.json()["routers"]

    r3 = client.put(f"/routers/{router_id}/prompt", json={"router_prompt": "custom prompt"})
    assert r3.status_code == 200
    assert r3.json()["router"]["router_prompt"] == "custom prompt"

    r4 = client.post(f"/routers/{router_id}/rename", json={"name": "Renamed"})
    assert r4.json()["router"]["name"] == "Renamed"

    r5 = client.delete(f"/routers/{router_id}")
    assert r5.status_code == 200


def test_ask_requires_router_id(client: TestClient) -> None:
    r = client.post("/ask", json={"question": "hello"})
    assert r.status_code == 422
