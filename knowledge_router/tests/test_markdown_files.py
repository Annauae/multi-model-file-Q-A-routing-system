from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from knowledge_router.app.file_processor import extract_pdf_to_markdown
from knowledge_router.app.main import create_app
from knowledge_router.app.markdown_files import build_markdown_files_tree
from knowledge_router.app.paths import documents_modules_dir_path, documents_sources_dir_path


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    config_path = tmp_path / "config" / "knowledge_bases.json"
    files_root = tmp_path / "files"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        '{"1":{"name":"test","match_prompt":"","status":"ready","created_at":"2026-06-23T00:00:00Z","updated_at":"2026-06-23T00:00:00Z"}}',
        encoding="utf-8",
    )
    qdir = files_root / "kb_1"
    qdir.mkdir(parents=True)
    (qdir / "questions.json").write_text('{"version":1,"items":[]}', encoding="utf-8")
    sources = documents_sources_dir_path(files_root)
    modules = documents_modules_dir_path(files_root)
    sources.mkdir(parents=True)
    modules.mkdir(parents=True)
    (modules / "pages").mkdir()
    (sources / "note.md").write_text("# Hello\n\nWorld\n", encoding="utf-8")
    (modules / "merged_p1-2.md").write_text("# Merged\n", encoding="utf-8")
    (modules / "pages" / "page_1.md").write_text("hidden page\n", encoding="utf-8")
    monkeypatch.setenv("DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("FILES_ROOT", str(files_root))
    monkeypatch.setenv("MOCK_LLM", "1")
    monkeypatch.setenv("API_KEY", "test")
    app = create_app()
    with TestClient(app) as c:
        yield c


def test_markdown_files_tree_hides_pages(client: TestClient) -> None:
    resp = client.get("/markdown-files/tree")
    assert resp.status_code == 200
    tree = resp.json()["tree"]
    assert len(tree) == 1
    doc = tree[0]
    assert doc["name"] == "documents"
    modules = next(c for c in doc["children"] if c["name"] == "modules")
    names = [f["name"] for f in modules["children"]]
    assert "merged_p1-2.md" in names
    assert "page_1.md" not in names


def test_markdown_files_read_write_delete(client: TestClient) -> None:
    path = "documents/modules/merged_p1-2.md"
    resp = client.get("/markdown-files/content", params={"path": path})
    assert resp.status_code == 200
    assert resp.json()["markdown"] == "# Merged\n"

    resp = client.put("/markdown-files/content", json={"path": path, "markdown": "# Updated\n\nLine2"})
    assert resp.status_code == 200
    assert resp.json()["line_count"] == 3

    resp = client.delete("/markdown-files", params={"path": path})
    assert resp.status_code == 200
    assert resp.json()["deleted"] is True


def test_markdown_files_create(client: TestClient) -> None:
    resp = client.post("/markdown-files", json={"name": "new_doc", "markdown": "# New\n"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["path"] == "documents/modules/new_doc.md"


def test_markdown_files_rename(client: TestClient) -> None:
    path = "documents/modules/merged_p1-2.md"
    resp = client.put("/markdown-files/rename", json={"path": path, "name": "renamed.md"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["path"] == "documents/modules/renamed.md"
    assert data["old_path"] == path

    read = client.get("/markdown-files/content", params={"path": data["path"]})
    assert read.status_code == 200
    assert read.json()["markdown"] == "# Merged\n"


def test_markdown_files_rejects_pages_path(client: TestClient) -> None:
    resp = client.get("/markdown-files/content", params={"path": "documents/modules/pages/page_1.md"})
    assert resp.status_code == 400


def test_build_tree_empty_root(tmp_path: Path) -> None:
    result = build_markdown_files_tree(tmp_path / "missing")
    assert result == {"tree": []}


def test_extract_pdf_cleans_page_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    files_root = tmp_path / "files"
    sources = documents_sources_dir_path(files_root)
    modules = documents_modules_dir_path(files_root)
    pages = modules / "pages"
    sources.mkdir(parents=True)
    pages.mkdir(parents=True)
    pdf = sources / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4 minimal")

    def fake_run_pdf_extract(**kwargs):  # noqa: ANN003
        out_dir = kwargs["out_dir"]
        out_dir.mkdir(parents=True, exist_ok=True)
        md = out_dir / "knowledge_p1-1.md"
        md.write_text("---\ntitle: x\n---\n# Page\n", encoding="utf-8")
        from knowledge_router.app.llm_client import TokenUsageResult

        return md, TokenUsageResult()

    monkeypatch.setattr("knowledge_router.app.file_processor._run_pdf_extract", fake_run_pdf_extract)

    merged_md, merged_path, stats = extract_pdf_to_markdown(
        files_root=files_root,
        source_path=pdf,
        page_start=1,
        page_end=1,
        for_documents=True,
    )
    assert merged_md
    assert merged_path.is_file()
    assert not (pages / "page_1.md").exists()
    assert stats["module_path"].startswith("documents/modules/")
