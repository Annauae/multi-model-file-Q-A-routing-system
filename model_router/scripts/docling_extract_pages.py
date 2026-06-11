"""Docling per-page extraction + batch Doubao VLM layout refinement → merged Markdown."""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(SCRIPTS))

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import ImageRefMode

from app.config import Settings
from app.llm_client import LLMClient, LLMError

from docling_vlm_refine import (
    asset_name,
    build_front_matter,
    knowledge_stem,
    merge_pages,
    refine_batch_markdown,
    render_pdf_page_png,
    rewrite_images_by_order,
    validate_page_markers,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract PDF pages via Docling, batch-refine layout with Doubao VLM, merge to one Markdown.",
    )
    parser.add_argument("--page-start", type=int, required=True, help="起始页码（从 1 开始，必填）")
    parser.add_argument("--page-end", type=int, required=True, help="结束页码（含，必填）")
    parser.add_argument(
        "--pdf",
        type=str,
        default="files/ZfcRGPRC_(Sc)12.pdf",
        help="PDF 路径（相对 model_router/ 或绝对路径）",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="files/temp",
        help="输出目录（相对 model_router/ 或绝对路径，默认 files/temp）",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="",
        help="VLM 模型接入点（默认 .env ANSWER_MODEL）",
    )
    parser.add_argument(
        "--skip-vlm",
        action="store_true",
        help="跳过 VLM 精修（仅 Docling 粗提取，调试用）",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        help="Docling 任一页失败或 VLM 缺少分页标记则立即退出",
    )
    return parser.parse_args()


def _resolve_path(base: Path, p: str) -> Path:
    path = Path(p)
    return path.resolve() if path.is_absolute() else (base / path).resolve()


def _ensure_output_dir(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "assets").mkdir(parents=True, exist_ok=True)


def _clean_batch_assets(assets_dir: Path, file_stem: str) -> None:
    """Remove stale images for this batch before re-extracting (does not touch other batches)."""
    for path in assets_dir.glob(f"{file_stem}_*.png"):
        path.unlink(missing_ok=True)


def _build_converter() -> DocumentConverter:
    pipeline_options = PdfPipelineOptions(
        generate_page_images=True,
        generate_picture_images=True,
        images_scale=1.0,
    )
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
        }
    )


def _docling_draft_for_page(
    *,
    converter: DocumentConverter,
    pdf: Path,
    page_no: int,
    assets_dir: Path,
    file_stem: str,
    next_image_idx: int,
) -> tuple[str, list[str], int]:
    """Run Docling on one page; return (draft_md, asset relative paths, next_image_idx)."""
    result = converter.convert(str(pdf), page_range=(page_no, page_no))
    doc = result.document

    asset_paths: list[str] = []
    idx = next_image_idx

    with tempfile.TemporaryDirectory(prefix="docling_page_") as tmp:
        tmp_dir = Path(tmp)
        tmp_md = tmp_dir / "draft.md"
        tmp_assets = tmp_dir / "artifacts"
        tmp_assets.mkdir(parents=True, exist_ok=True)

        doc.save_as_markdown(
            filename=tmp_md,
            artifacts_dir=tmp_assets,
            image_mode=ImageRefMode.REFERENCED,
        )
        draft = tmp_md.read_text(encoding="utf-8")

        images = sorted(tmp_assets.glob("*"))
        for src in images:
            dest_name = asset_name(file_stem, idx)
            dest = assets_dir / dest_name
            shutil.copy2(src, dest)
            asset_paths.append(f"assets/{dest_name}")
            idx += 1

    draft = rewrite_images_by_order(draft, asset_paths)
    return draft.strip(), asset_paths, idx


def main() -> None:
    args = _parse_args()
    page_start = args.page_start
    page_end = args.page_end
    if page_start < 1 or page_end < page_start:
        raise SystemExit("无效页码范围：page-start 须 >= 1 且 page-end >= page-start")

    pdf = _resolve_path(ROOT, args.pdf)
    out_dir = _resolve_path(ROOT, args.output_dir)
    assets_dir = out_dir / "assets"

    if not pdf.is_file():
        raise SystemExit(f"PDF 不存在：{pdf}")

    settings = Settings.load()
    model = (args.model or settings.answer_model).strip()
    if not args.skip_vlm and not settings.mock_llm and not settings.api_key:
        raise SystemExit("未配置 API_KEY，无法调用 VLM。请在 .env 设置或加 --skip-vlm。")

    _ensure_output_dir(out_dir)
    assets_dir.mkdir(parents=True, exist_ok=True)

    converter = _build_converter()
    llm = LLMClient(settings)

    file_stem = knowledge_stem(page_start, page_end)
    _clean_batch_assets(assets_dir, file_stem)

    print(f"Input:  {pdf}")
    print(f"Output: {out_dir}")
    print(f"Pages:  {page_start}-{page_end}")
    print(f"Stem:   {file_stem}")
    print(f"Model:  {model} (skip_vlm={args.skip_vlm})")

    page_drafts: list[tuple[int, str, list[str]]] = []
    page_assets: dict[int, list[str]] = {}
    ok_pages: list[int] = []
    fail_pages: list[tuple[int, str]] = []
    next_image_idx = 1

    # Phase A: Docling per page
    for page_no in range(page_start, page_end + 1):
        print(f"\n--- docling page {page_no} ---")
        try:
            draft, asset_paths, next_image_idx = _docling_draft_for_page(
                converter=converter,
                pdf=pdf,
                page_no=page_no,
                assets_dir=assets_dir,
                file_stem=file_stem,
                next_image_idx=next_image_idx,
            )
            page_drafts.append((page_no, draft, asset_paths))
            page_assets[page_no] = asset_paths
            ok_pages.append(page_no)
            print(f"  draft: {len(draft)} chars, images={len(asset_paths)}")
        except Exception as e:  # noqa: BLE001
            msg = f"{type(e).__name__}: {e}"
            fail_pages.append((page_no, msg))
            print(f"  FAILED: {msg}")
            if args.fail_fast:
                raise SystemExit(1) from e

    if not page_drafts:
        raise SystemExit("没有成功处理的页面，未生成输出。")

    # Phase B: merge coarse MD
    coarse_body = merge_pages([(n, md) for n, md, _ in page_drafts])
    all_assets = [p for _, _, paths in page_drafts for p in paths]
    page_numbers = [n for n, _, _ in page_drafts]
    print(f"\nCoarse merged MD: {len(coarse_body)} chars, {len(all_assets)} images")

    # Phase C: batch VLM (once for entire range)
    if args.skip_vlm:
        refined_body = coarse_body
        print("VLM skipped (--skip-vlm)")
    else:
        print(f"\n--- batch VLM ({len(page_numbers)} pages, 1 call) ---")
        page_pngs = [render_pdf_page_png(pdf, n) for n in page_numbers]
        refined_body = refine_batch_markdown(
            llm=llm,
            model=model,
            page_numbers=page_numbers,
            draft_md=coarse_body,
            asset_paths=all_assets,
            page_pngs=page_pngs,
            page_assets=page_assets,
            fail_on_missing_markers=args.fail_fast,
        )
        missing = validate_page_markers(refined_body, page_numbers)
        if missing:
            print(f"  WARN: missing page markers: {missing}")
        print(f"  refined: {len(refined_body)} chars")

    # Phase D: write output
    rel_pdf = pdf.relative_to(ROOT).as_posix() if pdf.is_relative_to(ROOT) else pdf.name
    front = build_front_matter(
        source_pdf=rel_pdf,
        page_start=page_start,
        page_end=page_end,
        page_count=len(page_drafts),
    )
    md_path = out_dir / f"{file_stem}.md"
    md_path.write_text(front + "\n" + refined_body, encoding="utf-8")

    imgs = sorted(assets_dir.glob("*"))
    print("\n=== summary ===")
    print(f"OK pages:   {ok_pages}")
    print(f"Fail pages: {fail_pages}")
    print(f"Markdown:   {md_path} ({md_path.stat().st_size} bytes)")
    print(f"Images:     {len(imgs)} in {assets_dir}")
    for p in imgs:
        print(f"  - {p.name} ({p.stat().st_size} bytes)")

    if fail_pages:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
