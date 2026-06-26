"""知识库文件上传、切分与 FAQ 导入流水线。"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

from .llm_client import LLMClient, LLMError, TokenUsageResult
from .paths import (
    documents_assets_dir_path,
    documents_modules_dir_path,
    kb_assets_dir_path,
    kb_modules_dir_path,
    kb_sources_dir_path,
)
from .pdf_sectionizer import MarkdownSection, filter_meaningful_sections, sectionize_markdown
from .questions_import import (
    assign_question_ids,
    generate_faq_from_section,
    generate_faq_items_from_markdown,
    strip_md_frontmatter,
)

_MD_IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_DOCLING_META_BLOCK = re.compile(
    r"---\s*\n(?:(?!---).)*?(?:route:|route_label:|source_pdf:)(?:(?!---).)*?\n---\s*\n?",
    re.DOTALL | re.IGNORECASE,
)
_PLACEHOLDER_HEADING_RE = re.compile(r"^#{1,3}\s*前言\s*$", re.MULTILINE)

# monorepo 内 model_router 的 docling 脚本
_MODEL_ROUTER_ROOT = Path(__file__).resolve().parents[2] / "model_router"
_DOCLING_SCRIPT = _MODEL_ROUTER_ROOT / "scripts" / "docling_extract_pages.py"


def _add_usage(total: TokenUsageResult, part: TokenUsageResult | None) -> None:
    if part is None:
        return
    total.prompt_tokens += int(part.prompt_tokens or 0)
    total.completion_tokens += int(part.completion_tokens or 0)
    total.total_tokens += int(part.total_tokens or 0) or (
        int(part.prompt_tokens or 0) + int(part.completion_tokens or 0)
    )


def clean_page_markdown(md_text: str) -> str:
    """移除 Docling 提取产物中的 YAML 元数据、空「前言」标题等。"""
    text = md_text or ""
    for _ in range(8):
        prev = text
        text = strip_md_frontmatter(text)
        text = _DOCLING_META_BLOCK.sub("", text)
        if text == prev:
            break
    text = _PLACEHOLDER_HEADING_RE.sub("", text)
    lines = text.splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines).strip()



def extract_md_line_range(md_text: str, line_start: int, line_end: int) -> str:
    lines = md_text.splitlines()
    if line_start < 1 or line_end < line_start:
        return ""
    if line_start > len(lines):
        return ""
    return "\n".join(lines[max(0, line_start - 1) : min(len(lines), line_end)]).strip()


def _copy_assets_for_md(*, md_text: str, source_dirs: List[Path], assets_dir: Path) -> None:
    assets_dir.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    for ref in _MD_IMG_RE.findall(md_text):
        ref = (ref or "").strip()
        if not ref or ref.startswith(("http://", "https://", "data:")):
            continue
        name = Path(ref.replace("\\", "/")).name
        if name in seen:
            continue
        src: Path | None = None
        for d in source_dirs:
            for candidate in (d / ref, d / name, d / "assets" / name):
                if candidate.is_file():
                    src = candidate
                    break
            if src:
                break
        if src:
            shutil.copy2(src, assets_dir / name)
            seen.add(name)


def _read_extract_metrics(out_dir: Path) -> TokenUsageResult:
    usage = TokenUsageResult()
    metrics_path = out_dir / "extract_metrics.json"
    if not metrics_path.is_file():
        return usage
    try:
        raw = json.loads(metrics_path.read_text(encoding="utf-8"))
        tok = raw.get("tokens") if isinstance(raw, dict) else {}
        if isinstance(tok, dict):
            usage.prompt_tokens = int(tok.get("prompt_tokens") or 0)
            usage.completion_tokens = int(tok.get("completion_tokens") or 0)
            usage.total_tokens = int(tok.get("total_tokens") or 0) or (
                usage.prompt_tokens + usage.completion_tokens
            )
    except Exception:  # noqa: BLE001
        pass
    return usage


def _run_pdf_extract(
    *,
    pdf_path: Path,
    page_start: int,
    page_end: int,
    out_dir: Path,
    vlm_model: str = "",
    vlm_system_prompt: str = "",
) -> Tuple[Path, TokenUsageResult]:
    out_dir.mkdir(parents=True, exist_ok=True)
    if not _DOCLING_SCRIPT.is_file():
        raise LLMError(f"PDF 提取脚本不存在: {_DOCLING_SCRIPT}，请确认 model_router 在同一 monorepo 内。")
    cmd = [
        sys.executable,
        str(_DOCLING_SCRIPT),
        "--pdf",
        str(pdf_path.resolve()),
        "--page-start",
        str(page_start),
        "--page-end",
        str(page_end),
        "--output-dir",
        str(out_dir.resolve()),
    ]
    if vlm_model:
        cmd.extend(["--model", vlm_model])
    prompt_file: Path | None = None
    if vlm_system_prompt.strip():
        fd, prompt_path = tempfile.mkstemp(suffix=".txt", prefix="kr_vlm_prompt_")
        prompt_file = Path(prompt_path)
        with open(fd, "w", encoding="utf-8") as f:
            f.write(vlm_system_prompt.strip())
        cmd.extend(["--vlm-system-prompt-file", str(prompt_file.resolve())])
    try:
        result = subprocess.run(
            cmd,
            cwd=str(_MODEL_ROUTER_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    finally:
        if prompt_file and prompt_file.is_file():
            prompt_file.unlink(missing_ok=True)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "")[-2000:]
        raise LLMError(f"PDF 提取失败 ({result.returncode}): {tail}")
    stem = f"knowledge_p{page_start}-{page_end}"
    md_path = out_dir / f"{stem}.md"
    if not md_path.is_file():
        md_files = sorted(out_dir.glob("*.md"))
        if not md_files:
            raise LLMError("PDF 提取未生成 Markdown 文件")
        md_path = md_files[0]
    return md_path, _read_extract_metrics(out_dir)


def process_md_range(
    *,
    files_root: Path,
    kb_id: str,
    source_path: Path,
    line_start: int,
    line_end: int,
    label: str,
) -> Tuple[Path, str]:
    """从 MD 源文件按行范围切分并写入 modules。"""
    md_text = source_path.read_text(encoding="utf-8")
    chunk = extract_md_line_range(md_text, line_start, line_end)
    if not chunk:
        raise LLMError(f"行范围 {line_start}-{line_end} 无内容")
    modules_dir, assets_dir = _resolve_storage_dirs(files_root, kb_id, for_documents=for_documents)
    modules_dir.mkdir(parents=True, exist_ok=True)
    _copy_assets_for_md(md_text=chunk, source_dirs=[source_path.parent, source_path.parent / "assets"], assets_dir=assets_dir)
    out = modules_dir / f"module_l{line_start}-{line_end}.md"
    out.write_text(chunk, encoding="utf-8")
    return out, label or out.name


def process_pdf_range(
    *,
    files_root: Path,
    kb_id: str,
    source_path: Path,
    page_start: int,
    page_end: int,
    label: str,
    vlm_model: str = "",
    vlm_system_prompt: str = "",
) -> Tuple[Path, str]:
    modules_dir = kb_modules_dir_path(files_root, kb_id)
    assets_dir = kb_assets_dir_path(files_root, kb_id)
    tmp = modules_dir / f"_extract_p{page_start}-{page_end}"
    md_path, page_usage = _run_pdf_extract(
        pdf_path=source_path,
        page_start=page_start,
        page_end=page_end,
        out_dir=tmp,
        vlm_model=vlm_model,
        vlm_system_prompt=vlm_system_prompt,
    )
    md_text = md_path.read_text(encoding="utf-8")
    _copy_assets_for_md(md_text=md_text, source_dirs=[tmp, tmp / "assets"], assets_dir=assets_dir)
    out = modules_dir / f"module_p{page_start}-{page_end}.md"
    shutil.copy2(md_path, out)
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)
    return out, label or out.name


def _faq_pipeline_from_markdown(
    merged_md: str,
    *,
    llm: LLMClient,
    import_model: str,
    on_progress: Callable[[str], None] | None,
    total_usage: TokenUsageResult,
    t_llm0: float,
    prepare_ms: float,
    t0: float,
    pages: int = 0,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """章节切分 → 内容检查 → 分段 FAQ 生成。"""

    def emit(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    sections, merge_usage = sectionize_markdown(
        merged_md,
        llm=llm,
        import_model=import_model,
        on_progress=emit,
    )
    _add_usage(total_usage, merge_usage)
    emit(f"[step] 检查 {len(sections)} 个章节内容…")
    sections, skipped_sections = filter_meaningful_sections(sections)
    for sec in skipped_sections:
        emit(f"[step] 跳过无实质内容：{sec.title}")
    if skipped_sections:
        emit(f"[step] 已跳过 {len(skipped_sections)} 个章节，待生成 FAQ {len(sections)} 个")
    if not sections:
        raise LLMError("所有章节均无实质内容，未生成 FAQ")
    emit(f"[step] 开始生成 FAQ…")

    token_breakdown: List[Dict[str, Any]] = []
    if merge_usage.total_tokens or merge_usage.prompt_tokens or merge_usage.completion_tokens:
        token_breakdown.append({"phase": "章节合并", "usage": merge_usage.to_dict()})

    raw_items: List[Dict[str, Any]] = []
    for i, sec in enumerate(sections, 1):
        emit(f"[step] FAQ {i}/{len(sections)}: {sec.title}")
        item, faq_usage = generate_faq_from_section(
            section_md=sec.markdown,
            section_title=sec.title,
            llm=llm,
            import_model=import_model,
        )
        _add_usage(total_usage, faq_usage)
        token_breakdown.append({"phase": f"FAQ · {sec.title}", "usage": faq_usage.to_dict()})
        raw_items.append(item)
    llm_ms = (time.perf_counter() - t_llm0) * 1000.0
    total_ms = (time.perf_counter() - t0) * 1000.0
    stats = {
        "pages": pages,
        "sections": len(sections),
        "skipped_sections": len(skipped_sections),
        "items": len(raw_items),
        "timings": {
            "total_ms": total_ms,
            "prepare_ms": prepare_ms,
            "match_ms": llm_ms,
            "match_first_token_ms": 0.0,
            "lookup_ms": 0.0,
        },
        "tokens": total_usage.to_dict(),
        "token_breakdown": token_breakdown,
    }
    return raw_items, stats


def _resolve_storage_dirs(
    files_root: Path,
    kb_id: str,
    *,
    for_documents: bool = False,
) -> tuple[Path, Path]:
    if for_documents:
        return documents_modules_dir_path(files_root), documents_assets_dir_path(files_root)
    return kb_modules_dir_path(files_root, kb_id), kb_assets_dir_path(files_root, kb_id)


def extract_markdown_range(
    *,
    files_root: Path,
    kb_id: str = "",
    source_path: Path,
    line_start: int,
    line_end: int,
    on_progress: Callable[[str], None] | None = None,
    for_documents: bool = False,
) -> Tuple[str, Path, Dict[str, Any]]:
    """Markdown 按行范围提取，返回合并 markdown 与统计。"""
    if line_start < 1 or line_end < line_start:
        raise LLMError("无效行范围")

    def emit(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    t0 = time.perf_counter()
    md_text = source_path.read_text(encoding="utf-8")
    chunk = extract_md_line_range(md_text, line_start, line_end)
    if not chunk:
        raise LLMError(f"行范围 {line_start}-{line_end} 无内容")

    modules_dir, assets_dir = _resolve_storage_dirs(files_root, kb_id, for_documents=for_documents)
    modules_dir.mkdir(parents=True, exist_ok=True)
    merged_md = clean_page_markdown(chunk)
    _copy_assets_for_md(
        md_text=merged_md,
        source_dirs=[source_path.parent, source_path.parent / "assets"],
        assets_dir=assets_dir,
    )
    module_out = modules_dir / f"module_l{line_start}-{line_end}.md"
    module_out.write_text(merged_md, encoding="utf-8")
    emit(f"[step] 已读取 Markdown 行 {line_start}-{line_end}")

    total_ms = (time.perf_counter() - t0) * 1000.0
    lines = merged_md.splitlines()
    stats = {
        "pages": 0,
        "line_count": len(lines),
        "module_path": str(module_out.relative_to(files_root)).replace("\\", "/"),
        "timings": {
            "total_ms": total_ms,
            "prepare_ms": total_ms,
            "match_ms": 0.0,
            "match_first_token_ms": 0.0,
            "lookup_ms": 0.0,
        },
        "tokens": TokenUsageResult().to_dict(),
        "token_breakdown": [],
    }
    return merged_md, module_out, stats


def extract_pdf_to_markdown(
    *,
    files_root: Path,
    kb_id: str = "",
    source_path: Path,
    page_start: int,
    page_end: int,
    vlm_model: str = "",
    vlm_system_prompt: str = "",
    on_progress: Callable[[str], None] | None = None,
    for_documents: bool = False,
) -> Tuple[str, Path, Dict[str, Any]]:
    """逐页 Docling+VLM 提取并合并为 Markdown，不生成 FAQ。"""
    if page_start < 1 or page_end < page_start:
        raise LLMError("无效页码范围")

    def emit(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    t0 = time.perf_counter()
    extract_ms = 0.0

    modules_dir, assets_dir = _resolve_storage_dirs(files_root, kb_id, for_documents=for_documents)
    pages_dir = modules_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    page_mds: List[tuple[int, str]] = []
    total_usage = TokenUsageResult()
    token_breakdown: List[Dict[str, Any]] = []
    total_pages = page_end - page_start + 1
    for i, page_no in enumerate(range(page_start, page_end + 1), 1):
        emit(f"[step] 提取第 {page_no} 页 ({i}/{total_pages})…")
        t_page = time.perf_counter()
        tmp = pages_dir / f"_extract_p{page_no}"
        md_path, page_usage = _run_pdf_extract(
            pdf_path=source_path,
            page_start=page_no,
            page_end=page_no,
            out_dir=tmp,
            vlm_model=vlm_model,
            vlm_system_prompt=vlm_system_prompt,
        )
        _add_usage(total_usage, page_usage)
        if page_usage.total_tokens or page_usage.prompt_tokens or page_usage.completion_tokens:
            token_breakdown.append({"phase": f"VLM · 第 {page_no} 页", "usage": page_usage.to_dict()})
        extract_ms += (time.perf_counter() - t_page) * 1000.0
        md_text = clean_page_markdown(md_path.read_text(encoding="utf-8"))
        _copy_assets_for_md(md_text=md_text, source_dirs=[tmp, tmp / "assets"], assets_dir=assets_dir)
        page_out = pages_dir / f"page_{page_no}.md"
        page_out.write_text(md_text, encoding="utf-8")
        page_mds.append((page_no, md_text))
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)

    merged_parts = [f"<!-- page {n} -->\n{md}" for n, md in page_mds]
    merged_md = clean_page_markdown("\n\n".join(merged_parts))
    merged_path = modules_dir / f"merged_p{page_start}-{page_end}.md"
    merged_path.write_text(merged_md, encoding="utf-8")
    emit(f"[step] 已合并 {len(page_mds)} 页 Markdown")

    for page_no, _ in page_mds:
        page_file = pages_dir / f"page_{page_no}.md"
        if page_file.is_file():
            page_file.unlink()
    for tmp_dir in pages_dir.glob("_extract_p*"):
        if tmp_dir.is_dir():
            shutil.rmtree(tmp_dir, ignore_errors=True)

    total_ms = (time.perf_counter() - t0) * 1000.0
    lines = merged_md.splitlines()
    stats = {
        "pages": len(page_mds),
        "line_count": len(lines),
        "module_path": str(merged_path.relative_to(files_root)).replace("\\", "/"),
        "timings": {
            "total_ms": total_ms,
            "prepare_ms": extract_ms,
            "match_ms": 0.0,
            "match_first_token_ms": 0.0,
            "lookup_ms": 0.0,
        },
        "tokens": total_usage.to_dict(),
        "token_breakdown": token_breakdown,
    }
    return merged_md, merged_path, stats


def save_module_markdown(
    *,
    files_root: Path,
    kb_id: str,
    module_path: str,
    markdown: str,
) -> Path:
    """保存用户编辑后的 module markdown。"""
    from .markdown_files import save_markdown_content

    rel = (module_path or "").strip().replace("\\", "/")
    if not rel:
        raise LLMError("module_path 必填")
    dest = (files_root / rel).resolve()
    if not dest.is_file():
        raise LLMError("module 文件不存在")
    save_markdown_content(files_root, rel, markdown)
    return dest


def process_markdown_import(
    *,
    files_root: Path,
    kb_id: str,
    source_path: Path,
    line_start: int,
    line_end: int,
    llm: LLMClient,
    import_model: str,
    on_progress: Callable[[str], None] | None = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Markdown 按行范围读取 → 标题 merge/split → 分段 FAQ 生成。"""
    t0 = time.perf_counter()
    total_usage = TokenUsageResult()
    merged_md, _module_out, _stats = extract_markdown_range(
        files_root=files_root,
        kb_id=kb_id,
        source_path=source_path,
        line_start=line_start,
        line_end=line_end,
        on_progress=on_progress,
    )
    t_llm0 = time.perf_counter()
    prepare_ms = (t_llm0 - t0) * 1000.0
    return _faq_pipeline_from_markdown(
        merged_md,
        llm=llm,
        import_model=import_model,
        on_progress=on_progress,
        total_usage=total_usage,
        t_llm0=t_llm0,
        prepare_ms=prepare_ms,
        t0=t0,
        pages=0,
    )


def process_pdf_import(
    *,
    files_root: Path,
    kb_id: str,
    source_path: Path,
    page_start: int,
    page_end: int,
    llm: LLMClient,
    import_model: str,
    vlm_model: str = "",
    vlm_system_prompt: str = "",
    on_progress: Callable[[str], None] | None = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """逐页 Docling+VLM 提取 → 标题 merge/split → 分段 FAQ 生成。"""
    t0 = time.perf_counter()
    total_usage = TokenUsageResult()
    merged_md, _merged_path, extract_stats = extract_pdf_to_markdown(
        files_root=files_root,
        kb_id=kb_id,
        source_path=source_path,
        page_start=page_start,
        page_end=page_end,
        vlm_model=vlm_model,
        vlm_system_prompt=vlm_system_prompt,
        on_progress=on_progress,
    )
    t_llm0 = time.perf_counter()
    prepare_ms = extract_stats.get("timings", {}).get("prepare_ms", 0.0)
    return _faq_pipeline_from_markdown(
        merged_md,
        llm=llm,
        import_model=import_model,
        on_progress=on_progress,
        total_usage=total_usage,
        t_llm0=t_llm0,
        prepare_ms=prepare_ms,
        t0=t0,
        pages=int(extract_stats.get("pages") or 0),
    )


def import_modules_to_kb(
    *,
    files_root: Path,
    kb_id: str,
    module_paths: List[Path],
    llm: LLMClient,
    import_model: str,
    on_progress: Callable[[str], None] | None = None,
) -> Tuple[List[Dict[str, Any]], TokenUsageResult]:
    """对每个模块 MD 调用 LLM 生成 FAQ 并返回合并 items + 总 token。"""
    all_items: List[Dict[str, Any]] = []
    total_usage = TokenUsageResult()
    store = None
    for i, mp in enumerate(module_paths, 1):
        if on_progress:
            on_progress(f"[{i}/{len(module_paths)}] 生成 FAQ: {mp.name}")
        md_text = mp.read_text(encoding="utf-8")
        items = generate_faq_items_from_markdown(
            md_text=md_text,
            source_label=mp.name,
            llm=llm,
            import_model=import_model,
        )
        all_items.extend(items)
    if not all_items:
        raise LLMError("未从模块生成任何 FAQ 条目")
    numbered = assign_question_ids(all_items, start=1)
    return numbered, total_usage


def save_imported_items(
    *,
    cache_store,
    kb_id: str,
    items: List[Dict[str, Any]],
    append: bool = True,
) -> int:
    """写入 questions.json；append=True 时追加到现有条目。"""
    store = cache_store
    doc = store.get_document()
    existing = {it.id: it for it in doc.items}
    from .schemas import QAItem

    added = 0
    for row in items:
        item = QAItem(
            id=row["id"],
            question=row["question"],
            variants=row.get("variants") or [],
            answer=row["answer"],
            enabled=True,
        )
        if item.id in existing and append:
            store.upsert_item(item=item.model_dump())
        elif item.id not in existing:
            store.upsert_item(item=item.model_dump())
            added += 1
        else:
            store.upsert_item(item=item.model_dump())
    return added
