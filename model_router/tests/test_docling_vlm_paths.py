"""Unit tests for Docling VLM extraction helpers (no real API/Docling)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(SCRIPTS))

from docling_vlm_refine import (  # noqa: E402
    append_missing_images,
    append_missing_images_batch,
    asset_name,
    batch_max_tokens,
    build_batch_user_content,
    build_front_matter,
    ensure_relative_asset_paths,
    extract_page_markers,
    knowledge_stem,
    merge_pages,
    normalize_image_paths,
    rewrite_images_by_order,
    strip_code_fence,
    validate_page_markers,
)


def test_knowledge_stem_format():
    assert knowledge_stem(1, 6) == "knowledge_p1-6"
    assert knowledge_stem(88, 103) == "knowledge_p88-103"


def test_asset_name_format():
    assert asset_name("knowledge_p1-6", 1) == "knowledge_p1-6_001.png"
    assert asset_name("knowledge_p88-103", 12) == "knowledge_p88-103_012.png"


def test_strip_code_fence_markdown():
    raw = "```markdown\n## Title\n\nbody\n```"
    assert strip_code_fence(raw) == "## Title\n\nbody"


def test_strip_code_fence_plain():
    assert strip_code_fence("plain text") == "plain text"


def test_rewrite_images_by_order():
    md = "![a](D:/abs/a.png)\n\n![b](rel/b.png)"
    assets = ["assets/knowledge_p1-6_001.png", "assets/knowledge_p1-6_002.png"]
    out = rewrite_images_by_order(md, assets)
    assert "assets/knowledge_p1-6_001.png" in out
    assert "assets/knowledge_p1-6_002.png" in out
    assert "D:/abs" not in out


def test_normalize_image_paths_by_basename():
    md = "![x](D:\\\\temp\\\\pages\\\\p002_assets\\\\image_000.png)"
    path_map = {"image_000.png": "assets/knowledge_p1-6_001.png"}
    out = normalize_image_paths(md, 2, path_map)
    assert "assets/knowledge_p1-6_001.png" in out


def test_ensure_relative_asset_paths():
    md = "![img](D:/foo/bar.png)"
    out = ensure_relative_asset_paths(md)
    assert "![img](assets/bar.png)" in out


def test_append_missing_images():
    md = "text only"
    assets = ["assets/knowledge_p1-6_001.png"]
    out = append_missing_images(md, assets)
    assert "## 本页插图" in out
    assert "assets/knowledge_p1-6_001.png" in out


def test_append_missing_images_skips_referenced():
    md = "![a](assets/knowledge_p1-6_001.png)"
    out = append_missing_images(md, ["assets/knowledge_p1-6_001.png"])
    assert "## 本页插图" not in out


def test_merge_pages_format():
    body = merge_pages([(1, "## A"), (2, "## B")])
    assert "<!-- page 1 -->" in body
    assert "<!-- page 2 -->" in body
    assert "## A" in body
    assert "## B" in body


def test_build_front_matter_fields():
    fm = build_front_matter(source_pdf="files/foo.pdf", page_start=88, page_end=103, page_count=16)
    assert "source_pdf: files/foo.pdf" in fm
    assert "page_start: 88" in fm
    assert "page_end: 103" in fm
    assert "pages: 16" in fm
    assert "generated_at:" in fm


def test_batch_max_tokens_scales_with_pages():
    assert batch_max_tokens(1) == 4608
    assert batch_max_tokens(16) == min(16384, 4096 + 512 * 16)
    assert batch_max_tokens(100) == 16384


def test_build_batch_user_content_structure():
    png = b"\x89PNG\r\n\x1a\n"
    parts = build_batch_user_content(
        page_numbers=[1, 2],
        draft_md="<!-- page 1 -->\n\nA\n\n<!-- page 2 -->\n\nB",
        asset_paths=["assets/knowledge_p1-6_001.png"],
        page_pngs=[png, png],
    )
    assert len(parts) == 3
    assert parts[0]["type"] == "image_url"
    assert parts[1]["type"] == "image_url"
    assert parts[2]["type"] == "text"
    text = parts[2]["text"]
    assert "第 1 张图 = PDF 第 1 页" in text
    assert "第 2 张图 = PDF 第 2 页" in text
    assert "<!-- page 1 -->" in text
    assert "assets/knowledge_p1-6_001.png" in text


def test_extract_and_validate_page_markers():
    md = "<!-- page 1 -->\n\nA\n\n<!-- page 3 -->\n\nC"
    assert extract_page_markers(md) == [1, 3]
    assert validate_page_markers(md, [1, 2, 3]) == [2]
    assert validate_page_markers(md, [1, 3]) == []


def test_append_missing_images_batch_per_page():
    md = "<!-- page 1 -->\n\nA\n\n<!-- page 2 -->\n\nB"
    assets = [
        "assets/knowledge_p1-6_001.png",
        "assets/knowledge_p1-6_002.png",
    ]
    page_assets = {
        1: ["assets/knowledge_p1-6_001.png"],
        2: ["assets/knowledge_p1-6_002.png"],
    }
    out = append_missing_images_batch(md, assets, page_assets=page_assets)
    assert "## 本页插图" in out
    assert "assets/knowledge_p1-6_001.png" in out
    assert "assets/knowledge_p1-6_002.png" in out
