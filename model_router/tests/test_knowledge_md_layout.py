"""Tests for knowledge loading from md/ subdirectory."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.knowledge_loader import resolve_agent_knowledge, resolve_knowledge_asset_path


def test_resolve_agent_knowledge_from_md_subdir(tmp_path: Path) -> None:
    data_root = tmp_path
    agent_dir = data_root / "files" / "router_1" / "agent_7"
    md_dir = agent_dir / "md"
    assets_dir = agent_dir / "assets"
    md_dir.mkdir(parents=True)
    assets_dir.mkdir(parents=True)
    (md_dir / "knowledge_p1-2.md").write_text("# Title\n\n![img](assets/foo.png)\n", encoding="utf-8")
    (assets_dir / "foo.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    text, source, _ = resolve_agent_knowledge(
        project_root=data_root,
        agent_id="7",
        files_dir="files/router_1/agent_7",
        configured_knowledge="",
        max_chars=10000,
    )
    assert "Title" in text
    assert source.endswith("knowledge_p1-2.md")

    resolved = resolve_knowledge_asset_path(
        project_root=data_root,
        files_dir="files/router_1/agent_7",
        asset_ref="assets/foo.png",
    )
    assert resolved is not None
    assert resolved.endswith("assets/foo.png")
