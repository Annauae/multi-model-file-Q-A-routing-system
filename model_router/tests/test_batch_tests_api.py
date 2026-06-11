import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def batch_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("MOCK_LLM", "1")
    monkeypatch.setattr("app.config.load_dotenv", lambda *args, **kwargs: None)
    monkeypatch.setenv("API_BASE_URL", "https://example.invalid/v1")
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.setenv("ROUTER_MODEL", "router-mock-model")
    monkeypatch.setenv("INIT_MODEL", "init-mock-model")
    monkeypatch.setenv("ANSWER_MODEL", "answer-mock-model")

    data_root = tmp_path / "data_root"
    (data_root / "config").mkdir(parents=True, exist_ok=True)
    (data_root / "files").mkdir(parents=True, exist_ok=True)
    (data_root / "config" / "agents.json").write_text("{}", encoding="utf-8")
    (data_root / "config" / "batch_tests.json").write_text(
        json.dumps({"items": []}, ensure_ascii=False),
        encoding="utf-8",
    )
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    from app.main import create_app

    return TestClient(create_app())


def test_create_and_list_batch_test(batch_client: TestClient) -> None:
    resp = batch_client.post(
        "/batch/tests",
        json={"question": "快门在哪？", "reference_answer": "快门在机身顶部中央。"},
    )
    assert resp.status_code == 200
    item = resp.json()["item"]
    assert item["question"] == "快门在哪？"
    assert item["status"] == "pending"
    assert item["accuracy_percent"] is None

    listed = batch_client.get("/batch/tests").json()["items"]
    assert len(listed) == 1
    assert listed[0]["id"] == item["id"]


def test_import_batch_tests_json(batch_client: TestClient) -> None:
    payload = json.dumps(
        [
            {"question": "Q1", "reference_answer": "A1"},
            {"question": "Q2", "reference": "A2"},
        ],
        ensure_ascii=False,
    )
    resp = batch_client.post("/batch/tests/import", json={"text": payload, "format": "json"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["imported"] == 2
    assert len(batch_client.get("/batch/tests").json()["items"]) == 2


def test_import_batch_tests_md(batch_client: TestClient) -> None:
    md = "## Q: 怎么装挂带？\n\nA: 先套上端环扣。\n\n## Q: 快门在哪？\n\nA: 在顶部。\n"
    resp = batch_client.post("/batch/tests/import", json={"text": md, "format": "md"})
    assert resp.status_code == 200
    assert resp.json()["imported"] == 2


def test_update_and_delete_batch_test(batch_client: TestClient) -> None:
    item_id = batch_client.post(
        "/batch/tests",
        json={"question": "旧问题", "reference_answer": "旧回答"},
    ).json()["item"]["id"]

    upd = batch_client.put(f"/batch/tests/{item_id}", json={"question": "新问题"})
    assert upd.status_code == 200
    assert upd.json()["item"]["question"] == "新问题"

    deleted = batch_client.delete(f"/batch/tests/{item_id}")
    assert deleted.status_code == 200
    assert batch_client.get("/batch/tests").json()["items"] == []


def test_run_batch_test(batch_client: TestClient) -> None:
    batch_client.post("/agents/auto")
    store = batch_client.app.state.store
    with store._lock:
        cfg = store._cache.get("1")
        if isinstance(cfg, dict):
            cfg["status"] = "initialized"
            cfg["route_questions"] = ["快门在哪？", "快门按钮在哪"]
            store._save()

    item_id = batch_client.post(
        "/batch/tests",
        json={"question": "快门在哪？", "reference_answer": "快门在机身顶部中央。"},
    ).json()["item"]["id"]

    resp = batch_client.post(f"/batch/tests/{item_id}/run")
    assert resp.status_code == 200
    data = resp.json()
    assert data["item"]["status"] == "done"
    assert data["item"]["model_answer"]
    assert data["item"]["accuracy_percent"] == 85
    assert data["total_ms"] >= 0
