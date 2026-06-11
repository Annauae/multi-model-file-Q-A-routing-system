import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

fitz = pytest.importorskip("fitz")

from app.file_loader import read_pdf_text
from app.knowledge_loader import resolve_agent_knowledge
from app.pdf_knowledge import load_pdfs_as_knowledge


def _make_pdf(path: Path, *, text: str = "shutter release button on top") -> None:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    doc.save(str(path))
    doc.close()


def test_read_pdf_text_plain(tmp_path: Path) -> None:
    pdf_path = tmp_path / "manual.pdf"
    _make_pdf(pdf_path)

    text = read_pdf_text(pdf_path, max_chars=50000)
    assert "shutter release button" in text
    assert "![第" not in text
    assert not (tmp_path / ".manual.pdf.extracted.md").exists()


def test_load_pdfs_as_knowledge(tmp_path: Path) -> None:
    pdf_path = tmp_path / "guide.pdf"
    _make_pdf(pdf_path, text="mode selector switches shooting modes")

    text, note = load_pdfs_as_knowledge(
        pdf_paths=[pdf_path],
        project_root=tmp_path,
        max_chars=100000,
    )
    assert "mode selector" in text
    assert note is None


def test_resolve_agent_knowledge_from_pdf(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    agent_dir.mkdir(parents=True)
    pdf_path = agent_dir / "guide.pdf"
    _make_pdf(pdf_path, text="mode selector switches shooting modes")

    text, source, note = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="4",
        configured_knowledge="",
        max_chars=100000,
        require_file_knowledge=True,
    )

    assert "mode selector" in text
    assert source == "files/agent_4/guide.pdf"
    assert not (agent_dir / "assets").exists()
    assert not list(agent_dir.glob(".*.extracted.md"))


def test_md_still_takes_priority_over_pdf(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    agent_dir.mkdir(parents=True)
    (agent_dir / "knowledge.md").write_text("from markdown", encoding="utf-8")
    _make_pdf(agent_dir / "guide.pdf", text="from pdf")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="4",
        configured_knowledge="",
        max_chars=100000,
    )
    assert text == "from markdown"
    assert source == "files/agent_4/knowledge.md"


def test_any_md_filename_is_used(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    agent_dir.mkdir(parents=True)
    (agent_dir / "knowledge_p1-6.md").write_text("from custom md", encoding="utf-8")
    _make_pdf(agent_dir / "guide.pdf", text="from pdf")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="4",
        configured_knowledge="",
        max_chars=100000,
    )
    assert text == "from custom md"
    assert source == "files/agent_4/knowledge_p1-6.md"


def test_hidden_extracted_md_is_ignored_when_knowledge_md_missing(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    agent_dir.mkdir(parents=True)
    (agent_dir / ".knowledge.pdf.extracted.md").write_text("stale cache", encoding="utf-8")
    _make_pdf(agent_dir / "knowledge.pdf", text="live pdf text")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="4",
        configured_knowledge="",
        max_chars=100000,
        require_file_knowledge=True,
    )
    assert "live pdf text" in text
    assert source == "files/agent_4/knowledge.pdf"
    assert "stale cache" not in text
