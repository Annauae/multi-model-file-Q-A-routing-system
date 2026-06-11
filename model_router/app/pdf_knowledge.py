from __future__ import annotations

from pathlib import Path
from typing import List, Tuple

from .file_loader import read_pdf_text


def list_agent_pdf_files(*, agent_dir: Path) -> List[Path]:
    if not agent_dir.is_dir():
        return []
    pdfs = [
        p
        for p in agent_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".pdf" and not p.name.startswith(".")
    ]
    pdfs.sort(key=lambda p: (p.name.lower() != "knowledge.pdf", p.name.lower()))
    return pdfs


def load_pdfs_as_knowledge(
    *,
    pdf_paths: List[Path],
    project_root: Path,
    max_chars: int,
) -> Tuple[str, str | None]:
    """Read PDF(s) with PyMuPDF; returns plain text (not markdown)."""
    chunks: List[str] = []
    used = 0
    note: str | None = None

    for pdf_path in pdf_paths:
        remaining = max_chars - used if max_chars > 0 else 0
        if max_chars > 0 and remaining <= 0:
            note = f"PDF 内容较长，已截取前 {max_chars} 字符"
            break
        try:
            rel = pdf_path.relative_to(project_root).as_posix()
        except Exception:
            rel = str(pdf_path)
        limit = remaining if max_chars > 0 else max_chars
        chunk = read_pdf_text(
            pdf_path,
            limit if limit > 0 else max_chars,
            include_page_markers=True,
            source_file_label=rel,
        ).strip()
        if chunk:
            chunks.append(chunk)
            used += len(chunk)

    text = "\n\n".join(chunks).strip()
    if max_chars > 0 and len(text) > max_chars:
        text = text[:max_chars]
        note = f"PDF 内容较长，已截取前 {max_chars} 字符"
    return text, note
