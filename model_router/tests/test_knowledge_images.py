import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.knowledge_loader import (
    extract_image_citations_from_knowledge,
    resolve_agent_knowledge,
    resolve_knowledge_asset_path,
)


def test_resolve_knowledge_asset_path(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    assets = agent_dir / "assets"
    agent_dir.mkdir(parents=True)
    assets.mkdir(parents=True)
    img = assets / "p016_figure_clip_001.png"
    img.write_bytes(b"fakepng")

    resolved = resolve_knowledge_asset_path(
        project_root=data_root,
        files_dir="files/agent_4",
        asset_ref="../assets/p016_figure_clip_001.png",
    )
    assert resolved == "files/agent_4/assets/p016_figure_clip_001.png"


def test_resolve_knowledge_asset_path_plain_assets_prefix(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    assets = agent_dir / "assets"
    agent_dir.mkdir(parents=True)
    assets.mkdir(parents=True)
    (assets / "p025_docling_picture002.png").write_bytes(b"fakepng")

    resolved = resolve_knowledge_asset_path(
        project_root=data_root,
        files_dir="files/agent_4",
        asset_ref="assets/p025_docling_picture002.png",
    )
    assert resolved == "files/agent_4/assets/p025_docling_picture002.png"


def test_extract_image_citations_from_knowledge(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    assets = agent_dir / "assets"
    agent_dir.mkdir(parents=True)
    assets.mkdir(parents=True)
    (assets / "p025_docling_picture002.png").write_bytes(b"fakepng")

    knowledge = "步骤说明\n\n![图](assets/p025_docling_picture002.png)\n"
    cites = extract_image_citations_from_knowledge(
        question="图在哪",
        knowledge=knowledge,
        knowledge_source="files/agent_4/knowledge.md",
        project_root=data_root,
        files_dir="files/agent_4",
    )
    assert len(cites) == 1
    assert cites[0].file == "files/agent_4/knowledge.md"
    assert cites[0].asset_file == "files/agent_4/assets/p025_docling_picture002.png"


def test_extract_image_citations_plain_assets_prefix(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    assets = agent_dir / "assets"
    agent_dir.mkdir(parents=True)
    assets.mkdir(parents=True)
    (assets / "p025_docling_picture002.png").write_bytes(b"fakepng")

    knowledge = "![图](assets/p025_docling_picture002.png)\n"
    cites = extract_image_citations_from_knowledge(
        question="图",
        knowledge=knowledge,
        knowledge_source="files/agent_4/knowledge.md",
        project_root=data_root,
        files_dir="files/agent_4",
    )
    assert len(cites) == 1
    assert cites[0].asset_file == "files/agent_4/assets/p025_docling_picture002.png"


def test_resolve_agent_knowledge_legacy_flat_agent_dir(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_1"
    agent_dir.mkdir(parents=True)
    (agent_dir / "knowledge.md").write_text("legacy knowledge", encoding="utf-8")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="1",
        files_dir="",
        configured_knowledge="",
        max_chars=10000,
    )
    assert "legacy knowledge" in text
    assert source == "files/agent_1/knowledge.md"


def test_resolve_agent_knowledge_md_subdir(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    md_dir = data_root / "files" / "agent_12" / "md"
    md_dir.mkdir(parents=True)
    (md_dir / "knowledge_p1-6.md").write_text("# chunk\n", encoding="utf-8")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="12",
        files_dir="files/agent_12",
        configured_knowledge="",
        max_chars=10000,
    )
    assert "# chunk" in text
    assert source.endswith("knowledge_p1-6.md")
