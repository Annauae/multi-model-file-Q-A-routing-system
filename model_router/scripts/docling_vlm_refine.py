"""VLM refinement helpers for Docling page extraction pipeline."""
from __future__ import annotations

import base64
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from app.llm_client import ChatMessage, LLMClient, LLMError

_MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_CODE_FENCE_RE = re.compile(r"^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$", re.MULTILINE)
_PAGE_MARKER_RE = re.compile(r"<!--\s*page\s+(\d+)\s*-->")

VLM_SYSTEM_PROMPT = """你是技术手册 Markdown 整理助手（路线B：Docling 粗提取 + VLM 按 PDF 还原布局）。

你会收到：
1. PDF 某一页的渲染图（视觉参照）
2. Docling 粗提取的 Markdown 草稿
3. 本页已提取图片的相对路径列表（assets/...）

任务：对照 PDF 页图，修正 Markdown 使其尽量还原原 PDF 的标题层级、段落顺序、列表/表格与插图位置。

规则：
- 以 Docling 草稿为正文基础，对照 PDF 修正结构与排版；不要编造 PDF 中不存在的内容
- 图片引用必须使用提供的 assets/ 相对路径，禁止绝对路径；可调整图片在正文中的位置以贴近 PDF
- 保留编号符号（①②）、表格、引用块等原有语义
- 若草稿中有插图但未在正文中引用，可在文末用「## 本页插图」集中列出
- 只输出本页 Markdown 正文：不要 <!-- page --> 标记，不要用代码块包裹整个输出，不要添加解释性前言
"""

VLM_BATCH_SYSTEM_PROMPT = """你是技术手册 Markdown 整理助手（路线B：Docling 粗提取 + VLM 按 PDF 还原布局）。

你会收到：
1. 多页 PDF 渲染图（按页码顺序，第 1 张图对应第 1 页，以此类推）
2. 已合并的 Docling 粗提取 Markdown（含 <!-- page N --> 分页标记）
3. 全部已提取图片的相对路径列表（assets/...）

任务：对照各页 PDF 渲染图，修正整段 Markdown，使其尽量还原原 PDF 的标题层级、段落顺序、列表/表格与插图位置。

规则：
- 以 Docling 粗稿为正文基础，对照 PDF 修正结构与排版；不要编造 PDF 中不存在的内容
- 图片引用必须使用提供的 assets/ 相对路径，禁止绝对路径；可调整图片在正文中的位置以贴近 PDF
- 保留编号符号（①②）、表格、引用块等原有语义
- 必须保留 <!-- page N --> 分页标记，且页码与输入一致
- 若某页插图未在正文中引用，可在该页末尾用「## 本页插图」集中列出
- 只输出完整多页 Markdown 正文：不要用代码块包裹整个输出，不要添加解释性前言
"""


def strip_code_fence(text: str) -> str:
    s = (text or "").strip()
    m = _CODE_FENCE_RE.match(s)
    if m:
        return m.group(1).strip()
    if s.startswith("```"):
        lines = s.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return s


def knowledge_stem(page_start: int, page_end: int) -> str:
    return f"knowledge_p{page_start}-{page_end}"


def asset_name(file_stem: str, idx: int) -> str:
    return f"{file_stem}_{idx:03d}.png"


def rewrite_images_by_order(md: str, asset_paths: List[str]) -> str:
    """Replace image refs in document order with assets/p{page}_docling_picture{idx}.png."""
    idx = 0

    def repl(match: re.Match) -> str:
        nonlocal idx
        alt = match.group(1)
        if idx < len(asset_paths):
            ref = asset_paths[idx]
            idx += 1
            return f"![{alt}]({ref})"
        return match.group(0)

    return _MD_IMG_RE.sub(repl, md or "")


def normalize_image_paths(md: str, page_no: int, path_map: dict[str, str]) -> str:
    """Rewrite markdown image refs to assets/p{page}_docling_picture{idx}.png."""

    def repl(match: re.Match) -> str:
        alt = match.group(1)
        old_ref = match.group(2).strip()
        new_ref = path_map.get(old_ref) or path_map.get(Path(old_ref).name) or old_ref
        if not new_ref.startswith("assets/"):
            name = Path(new_ref.replace("\\", "/")).name
            if name.startswith(f"p{page_no:03d}_"):
                new_ref = f"assets/{name}"
            else:
                new_ref = f"assets/{name}"
        return f"![{alt}]({new_ref})"

    return _MD_IMG_RE.sub(repl, md or "")


def ensure_relative_asset_paths(md: str) -> str:
    """Force image refs to assets/ relative paths (no absolute paths)."""

    def repl(match: re.Match) -> str:
        alt = match.group(1)
        ref = match.group(2).strip()
        if ref.startswith("assets/"):
            return match.group(0)
        name = Path(ref.replace("\\", "/")).name
        return f"![{alt}](assets/{name})"

    return _MD_IMG_RE.sub(repl, md or "")


def append_missing_images(md: str, asset_paths: List[str]) -> str:
    """Append ## 本页插图 for assets not referenced in body."""
    body = md or ""
    referenced = {m.group(2).strip() for m in _MD_IMG_RE.finditer(body)}
    missing = [p for p in asset_paths if p not in referenced]
    if not missing:
        return body.strip()
    lines = [body.rstrip(), "", "## 本页插图", ""]
    for p in missing:
        lines.append(f"![page illustration]({p})")
    return "\n".join(lines).strip()


def append_missing_images_batch(
    md: str,
    asset_paths: List[str],
    page_assets: dict[int, List[str]] | None = None,
) -> str:
    """Append missing images per page section (after each <!-- page N --> block)."""
    if not asset_paths:
        return (md or "").strip()

    body = md or ""
    referenced = {m.group(2).strip() for m in _MD_IMG_RE.finditer(body)}
    missing_by_page: dict[int, List[str]] = {}

    if page_assets:
        for page_no, paths in page_assets.items():
            for p in paths:
                if p not in referenced:
                    missing_by_page.setdefault(page_no, []).append(p)
    else:
        for p in asset_paths:
            if p in referenced:
                continue
            m = re.match(r"assets/p(\d{3})_", p)
            page_no = int(m.group(1)) if m else 0
            missing_by_page.setdefault(page_no, []).append(p)

    if not missing_by_page:
        return body.strip()

    markers = list(_PAGE_MARKER_RE.finditer(body))
    if not markers:
        return append_missing_images(body, asset_paths)

    out_parts: List[str] = []
    for i, match in enumerate(markers):
        page_no = int(match.group(1))
        start = match.start()
        end = markers[i + 1].start() if i + 1 < len(markers) else len(body)
        section = body[start:end].rstrip()
        missing = missing_by_page.get(page_no, [])
        if missing:
            extra = ["", "## 本页插图", ""]
            extra.extend(f"![page illustration]({p})" for p in missing)
            section = section + "\n" + "\n".join(extra)
        out_parts.append(section)

    return "\n\n".join(out_parts).strip() + "\n"


def extract_page_markers(md: str) -> List[int]:
    return [int(m.group(1)) for m in _PAGE_MARKER_RE.finditer(md or "")]


def validate_page_markers(md: str, expected_pages: List[int]) -> List[int]:
    """Return page numbers from expected_pages that are missing in md."""
    found = set(extract_page_markers(md))
    return [p for p in expected_pages if p not in found]


def batch_max_tokens(page_count: int) -> int:
    return min(16384, 4096 + 512 * max(1, page_count))


def build_batch_user_content(
    *,
    page_numbers: List[int],
    draft_md: str,
    asset_paths: List[str],
    page_pngs: List[bytes],
) -> List[Dict[str, Any]]:
    if len(page_numbers) != len(page_pngs):
        raise ValueError("page_numbers 与 page_pngs 数量不一致")

    image_labels = "\n".join(
        f"- 第 {i + 1} 张图 = PDF 第 {page_no} 页" for i, page_no in enumerate(page_numbers)
    )
    asset_list = "\n".join(f"- {p}" for p in asset_paths) if asset_paths else "（无提取图片）"
    user_text = (
        f"以下 {len(page_numbers)} 张图片为 PDF 第 {page_numbers[0]}–{page_numbers[-1]} 页的渲染图，"
        "请按顺序对照各页还原布局。\n\n"
        f"{image_labels}\n\n"
        f"## Docling 粗提取 Markdown（已合并，含 <!-- page N --> 分页）\n\n{draft_md.strip()}\n\n"
        f"## 全部可用图片路径（仅可使用这些相对路径）\n\n{asset_list}"
    )

    parts: List[Dict[str, Any]] = [png_to_image_part(png) for png in page_pngs]
    parts.append({"type": "text", "text": user_text})
    return parts


def render_pdf_page_png(pdf_path: Path, page_no: int, *, zoom: float = 2.0) -> bytes:
    import fitz

    doc = fitz.open(str(pdf_path))
    try:
        if page_no < 1 or page_no > doc.page_count:
            raise ValueError(f"页码超出范围：{page_no}（PDF 共 {doc.page_count} 页）")
        page = doc.load_page(page_no - 1)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()


def png_to_image_part(png_bytes: bytes) -> dict:
    b64 = base64.b64encode(png_bytes).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}


def refine_page_markdown(
    *,
    llm: LLMClient,
    model: str,
    page_no: int,
    draft_md: str,
    asset_paths: List[str],
    page_png: bytes,
    max_tokens: int = 4096,
) -> str:
    asset_list = "\n".join(f"- {p}" for p in asset_paths) if asset_paths else "（本页无提取图片）"
    user_text = (
        f"PDF 第 {page_no} 页的渲染图见上方附件，请对照还原布局。\n\n"
        f"## Docling 粗提取 Markdown\n\n{draft_md.strip()}\n\n"
        f"## 本页可用图片路径（仅可使用这些相对路径）\n\n{asset_list}"
    )
    messages = [
        ChatMessage(role="system", content=VLM_SYSTEM_PROMPT),
        ChatMessage(
            role="user",
            content=[
                png_to_image_part(page_png),
                {"type": "text", "text": user_text},
            ],
        ),
    ]
    raw = llm.chat(model=model, messages=messages, max_tokens=max_tokens)
    refined = strip_code_fence(raw)
    refined = ensure_relative_asset_paths(refined)
    refined = append_missing_images(refined, asset_paths)
    if not refined.strip():
        raise LLMError(f"第 {page_no} 页 VLM 输出为空")
    return refined.strip()


def refine_batch_markdown(
    *,
    llm: LLMClient,
    model: str,
    page_numbers: List[int],
    draft_md: str,
    asset_paths: List[str],
    page_pngs: List[bytes],
    page_assets: dict[int, List[str]] | None = None,
    fail_on_missing_markers: bool = False,
) -> str:
    if not page_numbers:
        raise LLMError("page_numbers 为空，无法批量 VLM 精修")

    user_content = build_batch_user_content(
        page_numbers=page_numbers,
        draft_md=draft_md,
        asset_paths=asset_paths,
        page_pngs=page_pngs,
    )
    messages = [
        ChatMessage(role="system", content=VLM_BATCH_SYSTEM_PROMPT),
        ChatMessage(role="user", content=user_content),
    ]
    max_tokens = batch_max_tokens(len(page_numbers))
    raw = llm.chat(model=model, messages=messages, max_tokens=max_tokens)
    refined = strip_code_fence(raw)
    refined = ensure_relative_asset_paths(refined)
    refined = append_missing_images_batch(refined, asset_paths, page_assets=page_assets)

    missing = validate_page_markers(refined, page_numbers)
    if missing:
        msg = f"VLM 输出缺少分页标记：{missing}"
        if fail_on_missing_markers:
            raise LLMError(msg)

    if not refined.strip():
        raise LLMError("批量 VLM 输出为空")
    return refined.strip() + ("\n" if not refined.endswith("\n") else "")


def build_front_matter(
    *,
    source_pdf: str,
    page_start: int,
    page_end: int,
    page_count: int,
) -> str:
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return (
        "---\n"
        "route: b\n"
        "route_label: 路线B · Docling 粗提取 + VLM 整理 Markdown\n"
        f"source_pdf: {source_pdf}\n"
        f"page_start: {page_start}\n"
        f"page_end: {page_end}\n"
        f"pages: {page_count}\n"
        f"generated_at: {now}\n"
        "---\n"
    )


def merge_pages(page_markdowns: List[Tuple[int, str]]) -> str:
    parts: List[str] = []
    for page_no, text in page_markdowns:
        parts.append(f"<!-- page {page_no} -->\n\n{text.strip()}")
    return "\n\n".join(parts) + "\n"
