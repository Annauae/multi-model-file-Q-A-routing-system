"""全局 Markdown 文件树与 CRUD（documents 目录）。"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .llm_client import LLMError
from .paths import (
    DOCUMENTS_FOLDER,
    documents_assets_dir_path,
    documents_dir_path,
    documents_modules_dir_path,
    documents_sources_dir_path,
)


def _file_kind(name: str, parent: str) -> str | None:
    lower = name.lower()
    if parent == "sources":
        if lower.endswith(".pdf"):
            return "source_pdf"
        if lower.endswith(".md"):
            return "source_md"
        return None
    if parent == "modules" and lower.endswith(".md"):
        return "module_md"
    return None


def _file_meta(path: Path, files_root: Path, kind: str) -> Dict[str, Any]:
    rel = path.relative_to(files_root).as_posix()
    stat = path.stat()
    line_count = 0
    if kind != "source_pdf":
        try:
            line_count = len(path.read_text(encoding="utf-8").splitlines())
        except OSError:
            line_count = 0
    return {
        "type": "file",
        "name": path.name,
        "path": rel,
        "kind": kind,
        "size": stat.st_size,
        "line_count": line_count,
        "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }


def _folder_node(name: str, children: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"type": "folder", "name": name, "children": children}


def build_markdown_files_tree(files_root: Path) -> Dict[str, Any]:
    """扫描 documents/sources 与 documents/modules（不含 pages/）。"""
    root = files_root.resolve()
    doc_root = documents_dir_path(files_root)
    children: List[Dict[str, Any]] = []

    sources_dir = documents_sources_dir_path(files_root)
    if sources_dir.is_dir():
        src_files = []
        for f in sorted(sources_dir.iterdir()):
            if not f.is_file():
                continue
            kind = _file_kind(f.name, "sources")
            if kind:
                src_files.append(_file_meta(f, root, kind))
        if src_files:
            children.append(_folder_node("sources", src_files))

    modules_dir = documents_modules_dir_path(files_root)
    if modules_dir.is_dir():
        mod_files = []
        for f in sorted(modules_dir.iterdir()):
            if not f.is_file():
                continue
            kind = _file_kind(f.name, "modules")
            if kind:
                mod_files.append(_file_meta(f, root, kind))
        if mod_files:
            children.append(_folder_node("modules", mod_files))

    tree: List[Dict[str, Any]] = []
    if children:
        tree.append(_folder_node(DOCUMENTS_FOLDER, children))
    return {"tree": tree}


def resolve_document_path(files_root: Path, rel_path: str) -> Tuple[Path, str]:
    """解析 documents 下相对路径，返回 (绝对路径, kind)。"""
    rel = (rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not rel:
        raise LLMError("path 必填")
    if "/pages/" in f"/{rel}/" or rel.endswith("/pages"):
        raise LLMError("不允许访问 pages 目录")

    parts = rel.split("/")
    if len(parts) != 3 or parts[0] != DOCUMENTS_FOLDER:
        raise LLMError("无效路径")

    doc_base = documents_dir_path(files_root).resolve()
    dest = (files_root / rel).resolve()
    try:
        dest.relative_to(doc_base)
    except ValueError as e:
        raise LLMError("路径超出 documents 范围") from e

    if parts[1] == "sources":
        kind = _file_kind(parts[2], "sources")
        if not kind:
            raise LLMError("不支持的源文件类型")
        allowed = documents_sources_dir_path(files_root).resolve()
        if allowed not in dest.parents and dest.parent != allowed:
            raise LLMError("无效的 sources 路径")
        return dest, kind

    if parts[1] == "modules" and parts[2].lower().endswith(".md"):
        allowed = documents_modules_dir_path(files_root).resolve()
        if allowed not in dest.parents and dest.parent != allowed:
            raise LLMError("无效的 modules 路径")
        return dest, "module_md"

    raise LLMError("无效路径")


def read_markdown_content(files_root: Path, rel_path: str) -> Dict[str, Any]:
    dest, kind = resolve_document_path(files_root, rel_path)
    if kind == "source_pdf":
        raise LLMError("PDF 文件不可作为 Markdown 读取")
    if not dest.is_file():
        raise LLMError("文件不存在")
    text = dest.read_text(encoding="utf-8")
    return {
        "path": rel_path.replace("\\", "/"),
        "kind": kind,
        "markdown": text,
        "line_count": len(text.splitlines()) if text else 0,
        "size": dest.stat().st_size,
    }


def save_markdown_content(files_root: Path, rel_path: str, markdown: str) -> Dict[str, Any]:
    dest, kind = resolve_document_path(files_root, rel_path)
    if kind == "source_pdf":
        raise LLMError("PDF 文件不可编辑为 Markdown")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(markdown or "", encoding="utf-8")
    line_count = len((markdown or "").splitlines())
    return {
        "path": rel_path.replace("\\", "/"),
        "kind": kind,
        "line_count": line_count,
        "size": dest.stat().st_size,
    }


def delete_document_file(files_root: Path, rel_path: str) -> Dict[str, Any]:
    dest, kind = resolve_document_path(files_root, rel_path)
    if not dest.is_file():
        raise LLMError("文件不存在")
    dest.unlink()
    return {"path": rel_path.replace("\\", "/"), "kind": kind, "deleted": True}


def rename_document_file(files_root: Path, rel_path: str, new_name: str) -> Dict[str, Any]:
    dest, kind = resolve_document_path(files_root, rel_path)
    if not dest.is_file():
        raise LLMError("文件不存在")
    safe = (new_name or "").strip()
    if not safe:
        raise LLMError("name 必填")
    if safe != Path(safe).name or "/" in safe or "\\" in safe or ".." in safe:
        raise LLMError("无效文件名")
    if safe == dest.name:
        rel = dest.relative_to(files_root.resolve()).as_posix()
        return {"path": rel, "kind": kind, "name": dest.name, "old_path": rel_path.replace("\\", "/")}
    new_dest = dest.parent / safe
    if new_dest.exists():
        raise LLMError("目标文件名已存在")
    dest.rename(new_dest)
    rel = new_dest.relative_to(files_root.resolve()).as_posix()
    meta = _file_meta(new_dest, files_root.resolve(), kind)
    meta["old_path"] = rel_path.replace("\\", "/")
    return meta


def create_module_markdown(files_root: Path, name: str, markdown: str = "") -> Dict[str, Any]:
    """在 documents/modules/ 下新建 Markdown。"""
    safe = (name or "").strip()
    if not safe:
        raise LLMError("name 必填")
    if not safe.lower().endswith(".md"):
        safe = f"{safe}.md"
    if "/" in safe or "\\" in safe or ".." in safe:
        raise LLMError("无效文件名")

    modules_dir = documents_modules_dir_path(files_root)
    modules_dir.mkdir(parents=True, exist_ok=True)
    dest = modules_dir / safe
    if dest.exists():
        raise LLMError("文件已存在")
    dest.write_text(markdown or "", encoding="utf-8")
    rel = dest.relative_to(files_root.resolve()).as_posix()
    text = markdown or ""
    return {
        "path": rel,
        "kind": "module_md",
        "line_count": len(text.splitlines()),
        "size": dest.stat().st_size,
    }


def documents_source_path(files_root: Path, filename: str) -> Path:
    safe = Path(filename).name
    if not safe or safe != filename:
        raise LLMError("无效文件名")
    return documents_sources_dir_path(files_root) / safe
