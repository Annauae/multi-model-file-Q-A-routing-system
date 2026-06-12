"""Batch Docling extraction: read page ranges from config and run docling_extract_pages for each."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parents[1]
EXTRACT_SCRIPT = Path(__file__).resolve().parent / "docling_extract_pages.py"
_RANGE_LINE_RE = re.compile(r"\[\s*(\d+)\s*,\s*(\d+)\s*\]")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="按配置文件中的页码范围批量运行 docling_extract_pages.py。",
    )
    parser.add_argument(
        "--config",
        type=str,
        default="config/docling_ranges.json",
        help="范围配置文件（JSON 或每行 [start,end] 的文本，相对 model_router/）",
    )
    parser.add_argument(
        "--range",
        nargs=2,
        type=int,
        action="append",
        metavar=("START", "END"),
        help="额外指定一组页码范围，可重复，例如 --range 1 6 --range 7 10",
    )
    parser.add_argument("--pdf", type=str, default="", help="覆盖配置中的 PDF 路径")
    parser.add_argument("--output-dir", type=str, default="", help="覆盖配置中的输出目录")
    parser.add_argument("--model", type=str, default="", help="VLM 模型接入点")
    parser.add_argument("--skip-vlm", action="store_true", help="跳过 VLM 精修")
    parser.add_argument("--fail-fast", action="store_true", help="任一批次失败则立即退出")
    return parser.parse_args()


def _resolve_path(base: Path, p: str) -> Path:
    path = Path(p)
    return path.resolve() if path.is_absolute() else (base / path).resolve()


def _load_json_config(path: Path) -> tuple[str, str, list[tuple[int, int]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    pdf = str(data.get("pdf", "") or "").strip()
    output_dir = str(data.get("output_dir", "") or "").strip()
    raw_ranges = data.get("ranges", [])
    if not isinstance(raw_ranges, list):
        raise ValueError("config.ranges 必须是数组，例如 [[1, 6], [7, 10]]")
    ranges = [_normalize_range(item, source=f"{path.name} ranges[{i}]") for i, item in enumerate(raw_ranges)]
    return pdf, output_dir, ranges


def _load_text_ranges(path: Path) -> tuple[str, str, list[tuple[int, int]]]:
    ranges: list[tuple[int, int]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _RANGE_LINE_RE.search(stripped)
        if not match:
            raise ValueError(f"{path.name}:{line_no} 无法解析页码范围：{line!r}")
        ranges.append((int(match.group(1)), int(match.group(2))))
    return "", "", ranges


def _normalize_range(item: object, *, source: str) -> tuple[int, int]:
    if isinstance(item, (list, tuple)) and len(item) == 2:
        start, end = int(item[0]), int(item[1])
    elif isinstance(item, str):
        match = _RANGE_LINE_RE.search(item)
        if not match:
            raise ValueError(f"{source} 无法解析页码范围：{item!r}")
        start, end = int(match.group(1)), int(match.group(2))
    else:
        raise ValueError(f"{source} 必须是 [start, end] 或 \"[start,end]\"")
    if start < 1 or end < start:
        raise ValueError(f"{source} 无效页码范围：{start}-{end}")
    return start, end


def load_ranges_config(path: Path) -> tuple[str, str, list[tuple[int, int]]]:
    if not path.is_file():
        raise FileNotFoundError(f"配置文件不存在：{path}")
    if path.suffix.lower() == ".json":
        return _load_json_config(path)
    return _load_text_ranges(path)


def build_extract_command(
    *,
    page_start: int,
    page_end: int,
    pdf: str,
    output_dir: str,
    model: str,
    skip_vlm: bool,
    fail_fast: bool,
) -> list[str]:
    cmd = [
        sys.executable,
        str(EXTRACT_SCRIPT),
        "--page-start",
        str(page_start),
        "--page-end",
        str(page_end),
    ]
    if pdf:
        cmd.extend(["--pdf", pdf])
    if output_dir:
        cmd.extend(["--output-dir", output_dir])
    if model:
        cmd.extend(["--model", model])
    if skip_vlm:
        cmd.append("--skip-vlm")
    if fail_fast:
        cmd.append("--fail-fast")
    return cmd


def main() -> None:
    args = _parse_args()
    config_path = _resolve_path(ROOT, args.config)
    cfg_pdf, cfg_output_dir, cfg_ranges = load_ranges_config(config_path)

    pdf = (args.pdf or cfg_pdf).strip()
    output_dir = (args.output_dir or cfg_output_dir).strip()
    ranges = list(cfg_ranges)
    if args.range:
        ranges.extend((start, end) for start, end in args.range)

    if not ranges:
        raise SystemExit("未配置任何页码范围。请在配置文件中添加 ranges，或使用 --range START END。")

    print(f"Config: {config_path}")
    print(f"PDF:    {pdf or '(default)'}")
    print(f"Output: {output_dir or '(default)'}")
    print(f"Ranges: {ranges}")
    print(f"Total:  {len(ranges)} batch(es)\n")

    failed: list[tuple[int, int, int]] = []
    for index, (page_start, page_end) in enumerate(ranges, start=1):
        print(f"========== batch {index}/{len(ranges)}: pages {page_start}-{page_end} ==========")
        cmd = build_extract_command(
            page_start=page_start,
            page_end=page_end,
            pdf=pdf,
            output_dir=output_dir,
            model=args.model.strip(),
            skip_vlm=args.skip_vlm,
            fail_fast=args.fail_fast,
        )
        result = subprocess.run(cmd, cwd=ROOT, check=False)
        if result.returncode != 0:
            failed.append((page_start, page_end, result.returncode))
            print(f"FAILED: pages {page_start}-{page_end} (exit {result.returncode})\n")
            if args.fail_fast:
                raise SystemExit(result.returncode)
        else:
            print(f"OK: pages {page_start}-{page_end}\n")

    print("=== batch summary ===")
    print(f"Succeeded: {len(ranges) - len(failed)}/{len(ranges)}")
    if failed:
        for page_start, page_end, code in failed:
            print(f"  FAIL {page_start}-{page_end} (exit {code})")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
