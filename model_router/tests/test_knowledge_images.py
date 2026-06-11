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
    assets = data_root / "files" / "assets"
    agent_dir.mkdir(parents=True)
    assets.mkdir(parents=True)
    img = assets / "p016_figure_clip_001.png"
    img.write_bytes(b"fakepng")

    resolved = resolve_knowledge_asset_path(
        project_root=data_root,
        files_dir="files/agent_4",
        asset_ref="../assets/p016_figure_clip_001.png",
    )
    assert resolved == "files/assets/p016_figure_clip_001.png"


def test_resolve_knowledge_asset_path_plain_assets_prefix(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    assets = data_root / "files" / "assets"
    agent_dir.mkdir(parents=True)
    assets.mkdir(parents=True)
    (assets / "p025_docling_picture002.png").write_bytes(b"fakepng")

    resolved = resolve_knowledge_asset_path(
        project_root=data_root,
        files_dir="files/agent_4",
        asset_ref="assets/p025_docling_picture002.png",
    )
    assert resolved == "files/assets/p025_docling_picture002.png"


def test_extract_image_citations_from_knowledge(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_4"
    assets = data_root / "files" / "assets"
    agent_dir.mkdir(parents=True)
    assets.mkdir(parents=True)
    (assets / "p016_figure_clip_001.png").write_bytes(b"fakepng")

    knowledge = "\n".join(
        [
            "翻转显示屏可用于高位或低位拍摄。",
            "![使用照相机在高位拍摄时，将显示屏朝下。](../assets/p016_figure_clip_001.png)",
        ]
    )
    cites = extract_image_citations_from_knowledge(
        question="高位拍摄时显示屏怎么放？",
        knowledge=knowledge,
        knowledge_source="files/agent_4/knowledge.md",
        project_root=data_root,
        files_dir="files/agent_4",
        max_items=3,
    )
    assert len(cites) == 1
    assert cites[0].file == "files/agent_4/knowledge.md"
    assert cites[0].asset_file == "files/assets/p016_figure_clip_001.png"
    assert cites[0].line_start == 2
    assert "显示屏" in cites[0].snippet


def test_extract_image_citations_plain_assets_prefix(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    (data_root / "files" / "agent_4").mkdir(parents=True)
    assets = data_root / "files" / "assets"
    assets.mkdir(parents=True)
    (assets / "p025_docling_picture002.png").write_bytes(b"fakepng")

    knowledge = "![播放设置](assets/p025_docling_picture002.png)"
    cites = extract_image_citations_from_knowledge(
        question="播放设置照片查看",
        knowledge=knowledge,
        knowledge_source="files/agent_4/knowledge.md",
        project_root=data_root,
        files_dir="files/agent_4",
        max_items=3,
    )
    assert len(cites) == 1
    assert cites[0].file == "files/agent_4/knowledge.md"
    assert cites[0].asset_file == "files/assets/p025_docling_picture002.png"


def test_resolve_agent_knowledge_uses_file(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    agent_dir = data_root / "files" / "agent_1"
    agent_dir.mkdir(parents=True)
    (agent_dir / "knowledge.md").write_text("# from file\n", encoding="utf-8")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="1",
        files_dir="files/agent_1",
        configured_knowledge="from agents.json",
        max_chars=10000,
    )
    assert text == "# from file"
    assert source == "files/agent_1/knowledge.md"


def test_resolve_agent_knowledge_falls_back_to_configured(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    (data_root / "files" / "agent_12").mkdir(parents=True)

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="12",
        files_dir="files/agent_12",
        configured_knowledge="cached knowledge",
        max_chars=10000,
    )
    assert text == "cached knowledge"
    assert source == "knowledge"


def test_resolve_agent_knowledge_require_file_skips_configured(tmp_path: Path) -> None:
    data_root = tmp_path / "data_root"
    (data_root / "files" / "agent_12").mkdir(parents=True)

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="12",
        files_dir="files/agent_12",
        configured_knowledge="cached knowledge",
        max_chars=10000,
        require_file_knowledge=True,
    )
    assert text == ""
    assert source == "knowledge"
