from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .agents_store import AgentsStore
from .paths import agent_dir_path, source_files_root
from .config import Settings
from .initializer import generate_route_questions_and_summaries
from .knowledge_loader import resolve_agent_knowledge
from .llm_client import LLMClient, LLMError
from .routers_store import RoutersStore

_MD_IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_PAGE_MARKER_RE = re.compile(r"<!--\s*page\s+(\d+)\s*-->", re.IGNORECASE)
EXTRACT_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "docling_extract_pages.py"


def _rewrite_image_ref(ref: str) -> str:
    ref = (ref or "").strip()
    if not ref or ref.startswith(("http://", "https://", "data:")):
        return ref
    name = Path(ref.replace("\\", "/")).name
    if ref.startswith("assets/"):
        return f"assets/{name}"
    return f"assets/{name}"


def _rewrite_md_images(text: str) -> str:
    def repl(m: re.Match) -> str:
        old = m.group(0)
        ref = m.group(1)
        new_ref = _rewrite_image_ref(ref)
        return old.replace(f"({ref})", f"({new_ref})") if new_ref != ref else old

    return _MD_IMG_RE.sub(repl, text)


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            return text[end + 3 :].lstrip("\n")
    return text


def _parse_page_sections(md_text: str) -> Dict[int, str]:
    body = _strip_frontmatter(md_text)
    sections: Dict[int, List[str]] = {}
    current_page: int | None = None
    for line in body.splitlines():
        m = _PAGE_MARKER_RE.search(line.strip())
        if m:
            current_page = int(m.group(1))
            sections.setdefault(current_page, [])
            continue
        if current_page is not None:
            sections.setdefault(current_page, []).append(line)
    return {p: "\n".join(lines).strip() for p, lines in sections.items() if lines}


def extract_md_line_range(md_text: str, line_start: int, line_end: int) -> str:
    """Extract a line range from Markdown (1-based, inclusive)."""
    lines = md_text.splitlines()
    if line_start < 1 or line_end < line_start:
        return ""
    if line_start > len(lines):
        return ""
    chunk = lines[max(0, line_start - 1) : min(len(lines), line_end)]
    return "\n".join(chunk).strip()


def _ensure_agent_dirs(files_root: Path, router_id: str, agent_id: str) -> Tuple[Path, Path, Path]:
    agent_dir = agent_dir_path(files_root, router_id, agent_id)
    md_dir = agent_dir / "md"
    assets_dir = agent_dir / "assets"
    md_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)
    return agent_dir, md_dir, assets_dir


def _copy_assets_for_md(
    *,
    md_text: str,
    source_dirs: List[Path],
    assets_dir: Path,
) -> None:
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
            for candidate in (
                d / ref,
                d / name,
                d / "assets" / name,
                d / "assets" / "png" / name,
            ):
                if candidate.is_file():
                    src = candidate
                    break
            if src:
                break
        if src:
            shutil.copy2(src, assets_dir / name)
            seen.add(name)


def _deploy_extracted_range(
    *,
    project_root: Path,
    router_id: str,
    agent_id: str,
    page_start: int,
    page_end: int,
    temp_md: Path,
    temp_assets: Path,
) -> str:
    _, md_dir, assets_dir = _ensure_agent_dirs(project_root / "files", router_id, agent_id)
    stem = f"knowledge_p{page_start}-{page_end}"
    dest_md = md_dir / f"{stem}.md"
    text = temp_md.read_text(encoding="utf-8", errors="ignore")
    if temp_assets.is_dir():
        for img in temp_assets.iterdir():
            if img.is_file() and img.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
                shutil.copy2(img, assets_dir / img.name)
    text = _rewrite_md_images(text)
    dest_md.write_text(text, encoding="utf-8")
    return dest_md.relative_to(project_root).as_posix()


def _run_pdf_extract(
    *,
    project_root: Path,
    pdf_path: Path,
    page_start: int,
    page_end: int,
    temp_dir: Path,
    model: str = "",
    skip_vlm: bool = False,
) -> Tuple[Path, Path]:
    temp_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = temp_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        str(EXTRACT_SCRIPT),
        "--pdf",
        str(pdf_path),
        "--page-start",
        str(page_start),
        "--page-end",
        str(page_end),
        "--output-dir",
        str(temp_dir),
    ]
    if model:
        cmd.extend(["--model", model])
    if skip_vlm:
        cmd.append("--skip-vlm")
    result = subprocess.run(cmd, cwd=str(project_root), capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"docling_extract_pages failed ({result.returncode}): {result.stderr[-2000:] or result.stdout[-2000:]}"
        )
    stem = f"knowledge_p{page_start}-{page_end}"
    md_path = temp_dir / f"{stem}.md"
    if not md_path.is_file():
        raise RuntimeError(f"Expected output not found: {md_path}")
    return md_path, assets_dir


def initialize_agent(
    *,
    store: AgentsStore,
    settings: Settings,
    llm: LLMClient,
    agent_id: str,
) -> Dict[str, Any]:
    cfg = store.get(agent_id)
    if not cfg:
        raise KeyError("agent_id 不存在")
    configured_knowledge = str(cfg.get("knowledge", "") or cfg.get("answer_prompt", "") or "")
    files_dir = str(cfg.get("files_dir") or "")
    knowledge_text, knowledge_source, _ = resolve_agent_knowledge(
        project_root=settings.data_root,
        agent_id=agent_id,
        files_dir=files_dir,
        configured_knowledge=configured_knowledge,
        max_chars=settings.max_file_chars,
        require_file_knowledge=True,
    )
    if not knowledge_text:
        store.reset_agent_to_created(agent_id=agent_id)
        raise LLMError("知识内容为空，无法初始化")
    store.set_knowledge(agent_id=agent_id, knowledge=knowledge_text)
    route_questions, file_summaries = generate_route_questions_and_summaries(
        agent_id=agent_id,
        agent_name=str(cfg.get("name", agent_id)),
        knowledge=knowledge_text,
        knowledge_source=knowledge_source,
        llm=llm,
        init_model=settings.init_model,
        min_route_questions=settings.min_route_questions,
        max_route_questions=settings.max_route_questions,
    )
    updated = store.update_initialized(
        agent_id=agent_id,
        files=[knowledge_source],
        route_questions=route_questions,
        file_summaries=file_summaries,
    )
    return updated


def create_sub_agent(
    *,
    store: AgentsStore,
    routers_store: RoutersStore,
    router_id: str,
    files_root: Path,
    name: str = "",
) -> str:
    agent_id = store.next_available_agent_id()
    agent_name = (name or "").strip() or f"agent_{agent_id}"
    store.create_agent(agent_id=agent_id, name=agent_name, router_id=router_id)
    routers_store.assign_agent(router_id=router_id, agent_id=agent_id)
    _ensure_agent_dirs(files_root, router_id, agent_id)
    return agent_id


def split_router(
    *,
    router_id: str,
    ranges: List[List[int]],
    source_file: str,
    auto_initialize: bool,
    store: AgentsStore,
    routers_store: RoutersStore,
    settings: Settings,
    llm: LLMClient,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    router = routers_store.get(router_id)
    if not router:
        raise KeyError("router_id 不存在")

    if not ranges:
        raise ValueError("ranges 不能为空")

    src = (source_file or "").strip()
    if not src:
        files = router.get("source_files") or []
        if isinstance(files, list) and files:
            src = str(files[-1])
    if not src:
        raise ValueError("请先上传源文件或指定 source_file")

    src_path = (settings.data_root / src).resolve()
    if not src_path.is_file():
        raise ValueError(f"源文件不存在: {src}")

    suffix = src_path.suffix.lower()
    created: List[str] = []
    results: List[Dict[str, Any]] = []
    source_root = settings.files_root / "root"

    for idx, raw_range in enumerate(ranges):
        if not isinstance(raw_range, (list, tuple)) or len(raw_range) != 2:
            raise ValueError(f"无效范围: {raw_range}")
        page_start, page_end = int(raw_range[0]), int(raw_range[1])
        if page_start < 1 or page_end < page_start:
            unit = "行" if suffix == ".md" else "页"
            raise ValueError(f"无效{unit}范围: {page_start}-{page_end}")

        total = len(ranges)
        step = f"[{idx + 1}/{total}]"
        range_label = "行" if suffix == ".md" else "页"
        if progress_cb:
            progress_cb(f"{step} 正在提取第 {page_start}-{page_end} {range_label}…")

        try:
            knowledge_path = ""
            if suffix == ".pdf":
                if progress_cb:
                    progress_cb(f"{step} 调用 Docling 处理 PDF 第 {page_start}-{page_end} 页…")
                with tempfile.TemporaryDirectory(
                    prefix=f"split_{router_id}_p{page_start}_{page_end}_"
                ) as temp_dir_str:
                    temp_dir = Path(temp_dir_str)
                    md_path, assets_dir = _run_pdf_extract(
                        project_root=settings.data_root,
                        pdf_path=src_path,
                        page_start=page_start,
                        page_end=page_end,
                        temp_dir=temp_dir,
                        model=settings.answer_model,
                    )
                    if progress_cb:
                        progress_cb(f"{step} 提取完成，正在创建子 Agent…")
                    agent_id = create_sub_agent(
                        store=store,
                        routers_store=routers_store,
                        router_id=router_id,
                        files_root=settings.files_root,
                    )
                    knowledge_path = _deploy_extracted_range(
                        project_root=settings.data_root,
                        router_id=router_id,
                        agent_id=agent_id,
                        page_start=page_start,
                        page_end=page_end,
                        temp_md=md_path,
                        temp_assets=assets_dir,
                    )
            elif suffix == ".md":
                md_text = src_path.read_text(encoding="utf-8", errors="ignore")
                chunk = extract_md_line_range(md_text, page_start, page_end)
                if not chunk:
                    total = len(md_text.splitlines())
                    raise ValueError(
                        f"Markdown 中未找到行 {page_start}-{page_end} 的内容"
                        + (f"（文件共 {total} 行）" if total else "（文件为空）")
                    )
                if progress_cb:
                    progress_cb(f"{step} 按行切分完成，正在创建子 Agent…")
                agent_id = create_sub_agent(
                    store=store,
                    routers_store=routers_store,
                    router_id=router_id,
                    files_root=settings.files_root,
                )
                _, md_dir, assets_dir = _ensure_agent_dirs(settings.files_root, router_id, agent_id)
                stem = f"knowledge_p{page_start}-{page_end}"
                _copy_assets_for_md(
                    md_text=chunk,
                    source_dirs=[src_path.parent, settings.data_root / "files", source_root],
                    assets_dir=assets_dir,
                )
                chunk = _rewrite_md_images(chunk)
                dest_md = md_dir / f"{stem}.md"
                dest_md.write_text(chunk, encoding="utf-8")
                knowledge_path = dest_md.relative_to(settings.data_root).as_posix()
            else:
                raise ValueError(f"不支持的文件类型: {suffix}")

            init_status = "skipped"
            if auto_initialize:
                if progress_cb:
                    progress_cb(f"{step} 正在初始化 agent_{agent_id}…")
                initialize_agent(store=store, settings=settings, llm=llm, agent_id=agent_id)
                init_status = "initialized"
            else:
                store.set_files(agent_id=agent_id, files=[knowledge_path])

            if progress_cb:
                progress_cb(f"{step} 完成 · agent_{agent_id} · {knowledge_path}")

            created.append(agent_id)
            results.append(
                {
                    "agent_id": agent_id,
                    "page_start": page_start,
                    "page_end": page_end,
                    "knowledge_path": knowledge_path,
                    "init_status": init_status,
                    "status": "ok",
                }
            )
        except Exception as e:  # noqa: BLE001
            if progress_cb:
                progress_cb(
                    f"{step} 失败 · 第 {page_start}-{page_end} {range_label} · {type(e).__name__}: {e}"
                )
            results.append(
                {
                    "page_start": page_start,
                    "page_end": page_end,
                    "status": "error",
                    "error": f"{type(e).__name__}: {e}",
                }
            )

    routers_store.set_split_ranges(
        router_id=router_id,
        split_ranges=[[int(r[0]), int(r[1])] for r in ranges],
    )
    return {"router_id": router_id, "created_agents": created, "results": results}
