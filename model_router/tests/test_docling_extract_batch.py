from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from docling_extract_batch import build_extract_command, load_ranges_config  # noqa: E402


def test_load_json_ranges(tmp_path: Path) -> None:
    cfg = tmp_path / "docling_ranges.json"
    cfg.write_text(
        json.dumps(
            {
                "pdf": "files/sample.pdf",
                "output_dir": "files/temp",
                "ranges": [[1, 6], [7, 10]],
            }
        ),
        encoding="utf-8",
    )
    pdf, output_dir, ranges = load_ranges_config(cfg)
    assert pdf == "files/sample.pdf"
    assert output_dir == "files/temp"
    assert ranges == [(1, 6), (7, 10)]


def test_load_text_ranges(tmp_path: Path) -> None:
    cfg = tmp_path / "docling_ranges.txt"
    cfg.write_text(
        "# page ranges\n[1,6]\n\n[7,10]\n",
        encoding="utf-8",
    )
    pdf, output_dir, ranges = load_ranges_config(cfg)
    assert pdf == ""
    assert output_dir == ""
    assert ranges == [(1, 6), (7, 10)]


def test_invalid_range_raises(tmp_path: Path) -> None:
    cfg = tmp_path / "docling_ranges.json"
    cfg.write_text(json.dumps({"ranges": [[10, 1]]}), encoding="utf-8")
    with pytest.raises(ValueError, match="无效页码范围"):
        load_ranges_config(cfg)


def test_build_extract_command() -> None:
    cmd = build_extract_command(
        page_start=1,
        page_end=6,
        pdf="files/a.pdf",
        output_dir="files/temp",
        model="ep-xxx",
        skip_vlm=True,
        fail_fast=False,
    )
    assert "--page-start" in cmd and "1" in cmd
    assert "--page-end" in cmd and "6" in cmd
    assert "--pdf" in cmd and "files/a.pdf" in cmd
    assert "--output-dir" in cmd and "files/temp" in cmd
    assert "--model" in cmd and "ep-xxx" in cmd
    assert "--skip-vlm" in cmd
