import pytest
from fastapi.testclient import TestClient

import sys
from pathlib import Path

# Ensure `app` package is importable when running pytest from repo root
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    return _make_client(monkeypatch, tmp_path=tmp_path)


def _make_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path | None) -> TestClient:
    monkeypatch.setenv("MOCK_LLM", "1")
    monkeypatch.setenv("API_BASE_URL", "https://example.invalid/v1")
    monkeypatch.delenv("API_KEY", raising=False)
    # Ensure model names are deterministic and do not depend on user's local .env
    monkeypatch.setenv("ROUTER_MODEL", "router-mock-model")
    monkeypatch.setenv("INIT_MODEL", "init-mock-model")
    monkeypatch.setenv("ANSWER_MODEL", "answer-mock-model")

    if tmp_path is not None:
        data_root = tmp_path / "data_root"
        (data_root / "config").mkdir(parents=True, exist_ok=True)
        (data_root / "files" / "agent_tech_agent").mkdir(parents=True, exist_ok=True)

        # seed one initialized agent for routing
        agents_json = {
            "tech_agent": {
                "name": "技术文档助手",
                "status": "initialized",
                "knowledge": "Authorization: Bearer <token>\nPOST /v1/payments",
                "answer_instructions": "",
                "files_dir": "files/agent_tech_agent",
                "files": ["files/agent_tech_agent/example_api.md"],
                "route_questions": ["这个接口怎么调用？", "请求参数有哪些？"],
                "file_summaries": [
                    {"file": "files/agent_tech_agent/example_api.md", "summary": "包含接口说明与鉴权信息。"}
                ],
                "last_initialized_at": "2026-06-03T00:00:00Z",
            }
        }
        (data_root / "config" / "agents.json").write_text(
            __import__("json").dumps(agents_json, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (data_root / "files" / "agent_tech_agent" / "example_api.md").write_text(
            "Authorization: Bearer <token>\nPOST /v1/payments\n", encoding="utf-8"
        )

        monkeypatch.setenv("DATA_ROOT", str(data_root))

    from app.main import create_app

    app = create_app()
    return TestClient(app)


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"

def test_ui_index(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    assert "单问题测试" in resp.text
    assert "批量测试" in resp.text
    assert "管理" in resp.text
    assert "common.js" in resp.text


def test_list_agent_files(client: TestClient) -> None:
    resp = client.get("/agents/files")
    assert resp.status_code == 200
    data = resp.json()
    assert any(f["label"] == "agent_tech_agent/example_api.md" for f in data["files"])


def test_read_raw_file(client: TestClient) -> None:
    resp = client.get("/files/raw", params={"file": "files/agent_tech_agent/example_api.md"})
    assert resp.status_code == 200
    data = resp.json()
    assert "Authorization" in data["text"]
    assert data["char_count"] > 0


def test_preview_pdf(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Build a tiny PDF under FILES_ROOT and verify /preview returns PNG
    import os

    data_root = Path(os.getenv("DATA_ROOT") or str(tmp_path / "data_root"))
    pdf_dir = data_root / "files" / "agent_tech_agent"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = pdf_dir / "test.pdf"

    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "hello pdf preview")
    doc.save(str(pdf_path))
    doc.close()

    resp = client.get("/preview", params={"file": "files/agent_tech_agent/test.pdf", "page": 1, "zoom": 1.0})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    assert len(resp.content) > 1000


def test_agents(client: TestClient) -> None:
    resp = client.get("/agents")
    assert resp.status_code == 200
    data = resp.json()
    assert "agents" in data
    assert "API_KEY" not in resp.text


def test_ask_basic(client: TestClient) -> None:
    resp = client.post("/ask", json={"question": "这个接口怎么调用？"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["need_clarification"] is False
    assert len(data["target_agents"]) >= 1
    assert len(data["answers"]) >= 1
    assert data["merged_answer"]


def test_ask_stream_basic(client: TestClient) -> None:
    with client.stream("POST", "/ask/stream", json={"question": "这个接口怎么调用？"}) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = resp.read().decode("utf-8")
    assert "event: route_delta" in body
    assert "event: route" in body
    assert "event: delta" in body
    assert "event: done" in body
    assert "merged_answer" in body or "【引用】" in body or "MOCK" in body


def test_ask_need_clarification(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app import main as main_mod
    from app.schemas import RouterResult

    def _fake_route_question(**kwargs):
        return RouterResult(
            target_agents=[],
            need_clarification=True,
            clarification_question="请补充你想查询的是哪类文件内容，例如财报、合同还是技术文档？",
        )

    monkeypatch.setattr(main_mod, "route_question", _fake_route_question)

    resp = client.post("/ask", json={"question": "随便问一个问题"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["need_clarification"] is True
    assert data["answers"] == []
    assert data["merged_answer"] == ""


def test_preview_extracted_text(client: TestClient) -> None:
    resp = client.get("/preview-text", params={"file": "files/agent_tech_agent/example_api.md"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["file"] == "files/agent_tech_agent/example_api.md"
    assert data["char_count"] > 0
    assert "Authorization" in data["text"] or "SOURCE" in data["text"]


def test_preview_image(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import os

    data_root = Path(os.getenv("DATA_ROOT") or str(tmp_path / "data_root"))
    assets = data_root / "files" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    png = assets / "demo.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")

    resp = client.get("/preview-image", params={"file": "files/assets/demo.png"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/")


def test_preview_agent_context(client: TestClient) -> None:
    resp = client.get("/agents/tech_agent/preview-context")
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == "tech_agent"
    assert data["char_count"] > 0
    assert len(data["used_files"]) >= 1


def test_init_flow_create_register_initialize_refresh_and_routing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:

    # 1) create agent
    resp = client.post("/agents", json={"agent_id": "finance_agent", "name": "财报分析助手"})
    assert resp.status_code == 200
    assert resp.json()["agent_id"] == "finance_agent"
    assert resp.json()["agent"]["status"] == "created"
    assert resp.json()["agent"]["files_dir"] == "files/agent_finance_agent"

    # 2) upload a file into agent files dir
    upload_resp = client.post(
        "/agents/finance_agent/files/upload",
        files={"file": ("report.md", "营收 120 亿元，净利润 8.4 亿元。".encode("utf-8"), "text/markdown")},
    )
    assert upload_resp.status_code == 200
    assert "files/agent_finance_agent/report.md" in upload_resp.json()["agent"]["files"]

    # 3) initialize -> should generate route_questions + file_summaries and mark initialized
    init_resp = client.post("/agents/finance_agent/initialize")
    assert init_resp.status_code == 200
    assert init_resp.json()["agent_id"] == "finance_agent"
    assert init_resp.json()["status"] == "initialized"
    assert init_resp.json()["route_questions_count"] == 50

    get_resp = client.get("/agents/finance_agent")
    assert get_resp.status_code == 200
    agent = get_resp.json()["agent"]
    assert agent["status"] == "initialized"
    assert len(agent["route_questions"]) >= 50
    assert len(agent["file_summaries"]) == 1

    # 4) uninitialized agent should not participate in routing
    client.post("/agents", json={"agent_id": "not_ready_agent", "name": "未初始化助手"})
    client.post(
        "/agents/not_ready_agent/files/upload",
        files={"file": ("x.txt", b"some content", "text/plain")},
    )
    ask_resp = client.post("/ask", json={"question": "随便问一个问题"})
    assert ask_resp.status_code == 200
    target_ids = [x["agent_id"] for x in ask_resp.json()["target_agents"]]
    assert "not_ready_agent" not in target_ids

    # 5) after initialization, agent can be routed (force router output)
    def _router_choose_finance(*, model: str, messages, max_tokens=None):
        if model != client.app.state.settings.router_model:
            return client.app.state.llm._mock_chat(model=model, messages=messages)
        return __import__("json").dumps(
            {
                "target_agents": [
                    {
                        "agent_id": "finance_agent",
                        "matched_route_questions": ["（MOCK）可回答问题 1"],
                        "reason": "测试强制选择财报助手",
                        "rewritten_query": "请根据财报文件回答营收与净利润。",
                        "confidence": "high",
                    }
                ],
                "need_clarification": False,
                "clarification_question": "",
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(client.app.state.llm, "chat", _router_choose_finance)
    routed_resp = client.post("/ask", json={"question": "营收和净利润是多少？"})
    assert routed_resp.status_code == 200
    assert routed_resp.json()["need_clarification"] is False
    assert routed_resp.json()["target_agents"][0]["agent_id"] == "finance_agent"

    # 6) refresh should update route_questions
    old_questions = client.get("/agents/finance_agent").json()["agent"]["route_questions"]

    def _init_new_questions(*, model: str, messages, max_tokens=None):
        if model != client.app.state.settings.init_model:
            return client.app.state.llm._mock_chat(model=model, messages=messages)
        payload = {
            "route_questions": [f"（MOCK-NEW）问题 {i}" for i in range(1, 51)],
            "knowledge_summary": "（MOCK-NEW）更新后的摘要。",
        }
        return __import__("json").dumps(payload, ensure_ascii=False)

    monkeypatch.setattr(client.app.state.llm, "chat", _init_new_questions)
    refresh_resp = client.post("/agents/finance_agent/refresh")
    assert refresh_resp.status_code == 200
    new_questions = client.get("/agents/finance_agent").json()["agent"]["route_questions"]
    assert new_questions != old_questions

