from __future__ import annotations

import base64
import io
import re
import struct
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from .pdf_knowledge import list_agent_pdf_files, load_pdfs_as_knowledge
from .schemas import Citation

_MD_IMG_RE = re.compile(r"!\[.*?\]\(([^)]+)\)")
_LINE_PREFIX_RE = re.compile(r"^L(\d+)\s*\|\s*")
_CITE_LINE_RE = re.compile(
    r"【引用】\s*(?P<file>[^\s]+)\s+L(?P<start>\d+)(?:\s*[-–—]\s*L?(?P<end>\d+))?",
    re.IGNORECASE,
)
_CITE_LINE_ONLY_RE = re.compile(
    r"【引用】\s*L(?P<start>\d+)(?:\s*[-–—]\s*L?(?P<end>\d+))?",
    re.IGNORECASE,
)
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov"}
_MEDIA_EXTS = _IMAGE_EXTS | _VIDEO_EXTS
_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

NOT_FOUND_ANSWER = "当前知识库中未找到相关信息"


def count_knowledge_lines(knowledge: str) -> int:
    if not (knowledge or "").strip():
        return 0
    return len(knowledge.splitlines())


def add_line_numbers(knowledge: str) -> str:
    """Prefix each line with L{num} | for LLM citation."""
    lines = (knowledge or "").splitlines()
    if not lines:
        return ""
    return "\n".join(f"L{i} | {line}" for i, line in enumerate(lines, start=1))


def strip_line_prefix(line: str) -> tuple[int | None, str]:
    m = _LINE_PREFIX_RE.match(line or "")
    if not m:
        return None, (line or "").strip()
    return int(m.group(1)), line[m.end() :].strip()


def format_used_file_label(source: str, line_count: int) -> str:
    src = (source or "").strip() or "knowledge"
    if line_count > 0:
        return f"{src} · {line_count} 行"
    return src


def format_cited_line_refs(citations: List[Citation], knowledge_source: str = "") -> List[str]:
    """Format knowledge.md line ranges for display."""
    src = (knowledge_source or "").strip()
    out: List[str] = []
    seen: set[str] = set()
    for c in citations:
        ls = c.line_start if c.line_start and c.line_start > 0 else None
        le = c.line_end if c.line_end and c.line_end > 0 else None
        if ls is None:
            continue
        file = (c.file or "").strip()
        if src and (file.endswith(".md") or file == src or _is_image_asset_path(file)):
            display_file = src
        elif file.endswith(".md"):
            display_file = file
        else:
            continue
        if le is not None and le != ls:
            label = f"{display_file} · L{ls}-L{le}"
        else:
            label = f"{display_file} · L{ls}"
        if label not in seen:
            seen.add(label)
            out.append(label)
    return out


def _is_image_asset_path(path: str) -> bool:
    return Path((path or "").strip()).suffix.lower() in _IMAGE_EXTS


def _merge_line_numbers(line_nos: List[int]) -> List[tuple[int, int]]:
    if not line_nos:
        return []
    nums = sorted(set(line_nos))
    ranges: List[tuple[int, int]] = []
    start = end = nums[0]
    for n in nums[1:]:
        if n == end + 1:
            end = n
        else:
            ranges.append((start, end))
            start = end = n
    ranges.append((start, end))
    return ranges


def locate_answer_lines_in_knowledge(
    *,
    answer: str,
    knowledge: str,
    knowledge_source: str,
    min_line_len: int = 6,
) -> List[Citation]:
    """Map answer text back to line ranges in knowledge.md."""
    if is_not_found_answer(answer) or not (knowledge or "").strip():
        return []

    src = (knowledge_source or "knowledge.md").strip()
    knowledge_lines = knowledge.splitlines()
    matched: set[int] = set()

    for ans_line in (answer or "").splitlines():
        s = ans_line.strip()
        if len(s) < min_line_len:
            continue
        for i, raw in enumerate(knowledge_lines, start=1):
            kl = raw.strip()
            if not kl:
                continue
            _, plain = strip_line_prefix(kl)
            if not plain:
                continue
            if s == plain or (len(s) >= 10 and s in plain) or (len(plain) >= 10 and plain in s):
                matched.add(i)

    if not matched:
        return []

    out: List[Citation] = []
    for start, end in _merge_line_numbers(list(matched)):
        out.append(
            Citation(
                file=src,
                line_start=start,
                line_end=end,
                snippet=extract_knowledge_snippet(
                    knowledge=knowledge,
                    line_start=start,
                    line_end=end,
                ),
            )
        )
    return out


def parse_line_citations_from_answer(
    *,
    answer: str,
    knowledge_source: str,
    knowledge: str,
) -> List[Citation]:
    """Parse 【引用】 lines from model answer into structured citations."""
    if not (answer or "").strip():
        return []

    out: List[Citation] = []
    seen: set[tuple[str, int, int | None]] = set()
    default_file = (knowledge_source or "").strip()

    for raw_line in answer.splitlines():
        line = raw_line.strip()
        if "【引用】" not in line and "【原文】" not in line:
            continue

        line = line.replace("【原文】", "【引用】")
        m = _CITE_LINE_RE.search(line)
        if m:
            file_path = m.group("file").strip()
            start = int(m.group("start"))
            end = int(m.group("end")) if m.group("end") else start
        else:
            m2 = _CITE_LINE_ONLY_RE.search(line)
            if not m2 or not default_file:
                continue
            file_path = default_file
            start = int(m2.group("start"))
            end = int(m2.group("end")) if m2.group("end") else start

        if end < start:
            start, end = end, start
        key = (file_path, start, end)
        if key in seen:
            continue
        seen.add(key)

        snippet = extract_knowledge_snippet(knowledge=knowledge, line_start=start, line_end=end)
        out.append(
            Citation(
                file=file_path,
                page=None,
                line_start=start,
                line_end=end,
                snippet=snippet,
            )
        )
    return out


def strip_citation_lines_from_answer(answer: str) -> str:
    """Remove 【引用】/【原文】 lines from model output for user-facing display."""
    kept: List[str] = []
    for line in (answer or "").splitlines():
        s = line.strip()
        if "【引用】" in s or "【原文】" in s:
            continue
        kept.append(line)
    text = "\n".join(kept).strip()
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    return text


def _is_resolvable_image_ref(ref: str, *, project_root: Path, files_dir: str) -> bool:
    """True when markdown image ref resolves to a local file under files/."""
    r = (ref or "").strip()
    if not r or r.startswith(("http://", "https://", "data:")):
        return False
    return bool(
        resolve_knowledge_asset_path(
            project_root=project_root,
            files_dir=files_dir,
            asset_ref=r,
        )
    )


def _has_valid_display_images(body: str, *, project_root: Path, files_dir: str) -> bool:
    for m in _MD_IMG_RE.finditer(body or ""):
        if _is_resolvable_image_ref(m.group(1), project_root=project_root, files_dir=files_dir):
            return True
    return False


def _citation_to_image_markdown(
    c: Citation,
    lines: List[str],
    *,
    project_root: Path,
    files_dir: str,
) -> Optional[str]:
    ls = c.line_start if c.line_start and c.line_start > 0 else None
    if ls and ls <= len(lines):
        raw = lines[ls - 1]
        m = _MD_IMG_RE.search(raw)
        if m and _is_resolvable_image_ref(
            m.group(1), project_root=project_root, files_dir=files_dir
        ):
            return raw.strip()

    asset = (c.asset_file or "").strip()
    if not asset:
        return None
    ref = asset[len("files/") :] if asset.startswith("files/assets/") else asset
    if not _is_resolvable_image_ref(ref, project_root=project_root, files_dir=files_dir):
        ref = asset
    alt = (c.snippet or "示意图").strip()
    if len(alt) > 120:
        alt = alt[:119] + "…"
    return f"![{alt}]({ref})"


def _collect_citation_image_markdown_pool(
    citations: List[Citation],
    *,
    knowledge: str,
    project_root: Path,
    files_dir: str,
) -> List[str]:
    lines = (knowledge or "").splitlines()
    pool: List[str] = []
    seen: set[str] = set()

    for c in sorted(citations, key=lambda x: (x.line_start or 0, x.line_end or 0)):
        md = _citation_to_image_markdown(
            c, lines, project_root=project_root, files_dir=files_dir
        )
        if md and md not in seen:
            seen.add(md)
            pool.append(md)

    for c in citations:
        ls = c.line_start if c.line_start and c.line_start > 0 else None
        if ls is None:
            continue
        le = c.line_end if c.line_end and c.line_end >= ls else ls
        block = _page_block_bounds(lines, ls)
        ranges = [(max(lo, block[0]), min(hi, block[1])) for lo, hi in [(ls, le)]]
        for lo, hi in ranges:
            for md_line in _image_markdown_lines_in_range(
                lines,
                lo,
                hi,
                project_root=project_root,
                files_dir=files_dir,
            ):
                if md_line not in seen:
                    seen.add(md_line)
                    pool.append(md_line)

    return pool


def replace_invalid_display_images(
    display: str,
    *,
    knowledge: str,
    citations: List[Citation],
    project_root: Path,
    files_dir: str,
) -> str:
    """Replace hallucinated external ![](...) with resolvable images from citations/knowledge."""
    body = display or ""
    if not _MD_IMG_RE.search(body):
        return body

    pool = _collect_citation_image_markdown_pool(
        citations,
        knowledge=knowledge,
        project_root=project_root,
        files_dir=files_dir,
    )
    pool_idx = 0

    def _replacer(match: re.Match[str]) -> str:
        nonlocal pool_idx
        ref = match.group(1).strip()
        if _is_resolvable_image_ref(ref, project_root=project_root, files_dir=files_dir):
            return match.group(0)
        if pool_idx < len(pool):
            replacement = pool[pool_idx]
            pool_idx += 1
            return replacement
        return ""

    result = _MD_IMG_RE.sub(_replacer, body)
    while "\n\n\n" in result:
        result = result.replace("\n\n\n", "\n\n")
    return result.strip()


def _page_block_bounds(lines: List[str], line_no: int) -> tuple[int, int]:
    """Bounds between adjacent ``<!-- page N -->`` markers (inclusive)."""
    n = len(lines)
    idx = max(1, min(line_no, n))
    start = 1
    for i in range(idx, 0, -1):
        if lines[i - 1].strip().startswith("<!-- page"):
            start = i
            break
    end = n
    for i in range(idx + 1, n + 1):
        if lines[i - 1].strip().startswith("<!-- page"):
            end = i - 1
            break
    return start, end


def _image_markdown_lines_in_range(
    lines: List[str],
    start: int,
    end: int,
    *,
    project_root: Path,
    files_dir: str,
) -> List[str]:
    """Return original markdown image lines whose assets resolve on disk."""
    out: List[str] = []
    hi = min(end, len(lines))
    lo = max(1, start)
    for line_no in range(lo, hi + 1):
        raw = lines[line_no - 1]
        m = _MD_IMG_RE.search(raw)
        if not m:
            continue
        ref = m.group(1)
        if resolve_knowledge_asset_path(
            project_root=project_root,
            files_dir=files_dir,
            asset_ref=ref,
        ):
            out.append(raw.strip())
    return out


def _append_image_citations_from_range(
    out: List[Citation],
    seen: set[tuple],
    *,
    base: Citation,
    lines: List[str],
    range_start: int,
    range_end: int,
    project_root: Path,
    files_dir: str,
    max_items: int,
) -> bool:
    """Scan a line range for markdown images; return True if any were added."""
    added = False
    hi = min(range_end, len(lines))
    lo = max(1, range_start)
    for line_no in range(lo, hi + 1):
        raw = lines[line_no - 1]
        for m in _MD_IMG_RE.finditer(raw):
            ref = m.group(1)
            resolved = resolve_knowledge_asset_path(
                project_root=project_root,
                files_dir=files_dir,
                asset_ref=ref,
            )
            if not resolved:
                continue
            alt = raw[2 : raw.index("](")] if "](" in raw else ""
            item = Citation(
                file=base.file,
                line_start=line_no,
                line_end=line_no,
                snippet=alt.strip() or resolved,
                asset_file=resolved,
            )
            key = (item.file, item.line_start, item.line_end, item.asset_file, item.snippet)
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
            added = True
            if len(out) >= max_items:
                return added
    return added


def expand_citations_with_images_in_range(
    citations: List[Citation],
    *,
    knowledge: str,
    project_root: Path,
    files_dir: str,
    max_items: int = 8,
) -> List[Citation]:
    """Attach image assets from cited line ranges (for resources sidebar).

    If the cited range has no ``![](...)`` lines, fall back to the surrounding
    ``<!-- page N -->`` block (covers 「本页插图」 sections on another line range).
    """
    if not citations or not (knowledge or "").strip():
        return citations

    lines = knowledge.splitlines()
    out: List[Citation] = list(citations)
    seen: set[tuple] = set(
        (c.file, c.line_start, c.line_end, c.asset_file, c.snippet) for c in out
    )

    for c in citations:
        ls = c.line_start if c.line_start and c.line_start > 0 else None
        if ls is None:
            continue
        le = c.line_end if c.line_end and c.line_end >= ls else ls
        before = len(out)
        _append_image_citations_from_range(
            out,
            seen,
            base=c,
            lines=lines,
            range_start=ls,
            range_end=le,
            project_root=project_root,
            files_dir=files_dir,
            max_items=max_items,
        )
        if len(out) == before:
            block_start, block_end = _page_block_bounds(lines, ls)
            _append_image_citations_from_range(
                out,
                seen,
                base=c,
                lines=lines,
                range_start=block_start,
                range_end=block_end,
                project_root=project_root,
                files_dir=files_dir,
                max_items=max_items,
            )
        if len(out) >= max_items:
            return out
    return out


def append_missing_images_to_display(
    display: str,
    *,
    knowledge: str,
    citations: List[Citation],
    project_root: Path,
    files_dir: str,
) -> str:
    """When the model omits ``![](...)`` in the answer, append page-block images."""
    body = (display or "").strip()
    if _has_valid_display_images(body, project_root=project_root, files_dir=files_dir):
        return body

    lines = (knowledge or "").splitlines()
    if not lines or not citations:
        return body

    seen_blocks: set[tuple[int, int]] = set()
    img_lines: List[str] = []
    seen_md: set[str] = set()
    for c in citations:
        ls = c.line_start if c.line_start and c.line_start > 0 else None
        if ls is None:
            continue
        block = _page_block_bounds(lines, ls)
        if block in seen_blocks:
            continue
        seen_blocks.add(block)
        for md_line in _image_markdown_lines_in_range(
            lines,
            block[0],
            block[1],
            project_root=project_root,
            files_dir=files_dir,
        ):
            if md_line in seen_md:
                continue
            seen_md.add(md_line)
            img_lines.append(md_line)

    if not img_lines:
        return body
    return body + "\n\n" + "\n\n".join(img_lines)


def finalize_model_answer_display(
    *,
    raw_answer: str,
    knowledge: str,
    knowledge_source: str,
    project_root: Path,
    files_dir: str,
) -> tuple[str, List[Citation]]:
    """Parse model 【引用】 lines; return display answer (no cite lines) + citations."""
    raw = (raw_answer or "").strip()
    parsed = parse_line_citations_from_answer(
        answer=raw,
        knowledge_source=knowledge_source,
        knowledge=knowledge,
    )
    if parsed:
        citations = expand_citations_with_images_in_range(
            parsed,
            knowledge=knowledge,
            project_root=project_root,
            files_dir=files_dir,
        )
        display = strip_citation_lines_from_answer(raw)
        display = replace_invalid_display_images(
            display,
            knowledge=knowledge,
            citations=citations,
            project_root=project_root,
            files_dir=files_dir,
        )
        display = append_missing_images_to_display(
            display,
            knowledge=knowledge,
            citations=parsed,
            project_root=project_root,
            files_dir=files_dir,
        )
        return display, citations
    return raw, []


def extract_knowledge_snippet(*, knowledge: str, line_start: int, line_end: int, max_chars: int = 200) -> str:
    lines = (knowledge or "").splitlines()
    if not lines or line_start < 1:
        return ""
    end = min(line_end, len(lines))
    start = max(1, min(line_start, end))
    chunk = " ".join(lines[start - 1 : end]).strip()
    if len(chunk) > max_chars:
        return chunk[: max_chars - 1] + "…"
    return chunk


def agent_files_dir(agent_id: str) -> str:
    """Each agent is hard-bound to files/agent_{id}/ on disk."""
    return f"files/agent_{agent_id}"


def _resolve_dir(project_root: Path, files_dir: str) -> Path:
    p = Path(files_dir)
    if p.is_absolute():
        return p
    return (project_root / p).resolve()


def resolve_agent_knowledge(
    *,
    project_root: Path,
    agent_id: str,
    files_dir: str = "",
    configured_knowledge: str,
    max_chars: int,
    require_file_knowledge: bool = False,
) -> Tuple[str, str, Optional[str]]:
    """
    Load pure knowledge text for an agent (no role/rules — those are added by code).

    Always reads from files/agent_{id}/ (files_dir is ignored).

    Priority:
    1. files/agent_{id}/knowledge.md
    2. other single .md in that folder (non-recursive; knowledge.md excluded from scan loop)
    3. .pdf in that folder (PyMuPDF plain-text extraction on read; no .md conversion)
    4. configured_knowledge from agents.json (skipped when require_file_knowledge=True)
    """
    configured = (configured_knowledge or "").strip()
    dir_path = _resolve_dir(project_root, agent_files_dir(agent_id))

    candidates: list[tuple[str, Path]] = []
    pdf_paths: list[Path] = []
    if dir_path.is_dir():
        knowledge_md = dir_path / "knowledge.md"
        if knowledge_md.is_file():
            candidates.append((f"files/agent_{agent_id}/knowledge.md", knowledge_md))
        for p in sorted(dir_path.iterdir(), key=lambda x: x.name.lower()):
            if not p.is_file():
                continue
            if p.name.startswith("."):
                continue
            if p.suffix.lower() != ".md":
                continue
            if p.name.lower() in {"knowledge.md", "prompt.md"}:
                continue
            if p.name.lower().endswith(".extracted.md"):
                continue
            try:
                rel = p.relative_to(project_root).as_posix()
            except Exception:
                rel = str(p)
            candidates.append((rel, p))
        pdf_paths = list_agent_pdf_files(agent_dir=dir_path)

    text = ""
    source = "knowledge"
    note: Optional[str] = None

    if candidates:
        source, path = candidates[0]
        text = path.read_text(encoding="utf-8", errors="ignore").strip()
    elif pdf_paths:
        try:
            rel_paths: list[str] = []
            for p in pdf_paths:
                try:
                    rel_paths.append(p.relative_to(project_root).as_posix())
                except Exception:
                    rel_paths.append(str(p))
            source = rel_paths[0] if len(rel_paths) == 1 else ", ".join(rel_paths)
            text, pdf_note = load_pdfs_as_knowledge(
                pdf_paths=pdf_paths,
                project_root=project_root,
                max_chars=max_chars,
            )
            note = pdf_note
        except Exception as e:
            text = ""
            note = f"PDF 读取失败：{type(e).__name__}: {e}"
    elif configured and not require_file_knowledge:
        text = configured
        source = "knowledge"

    if text and max_chars > 0 and len(text) > max_chars:
        text = text[:max_chars]
        if not note:
            note = f"知识内容较长，已截取前 {max_chars} 字符"

    return text, source, note


def _build_answer_rules_text(
    *,
    agent_name: str,
    answer_instructions: str,
    max_answer_chars: int = 0,
) -> str:
    extra = ""
    instr = (answer_instructions or "").strip()
    if instr:
        extra = f"\n【本 agent 补充要求】\n{instr}\n"

    length_rule = ""
    if max_answer_chars > 0:
        length_rule = (
            f"6. 输出总长不超过 {max_answer_chars} 个汉字；请精炼归纳，优先给出与用户问题最相关的要点。\n"
        )

    return (
        f"你是「{agent_name}」领域的问答助手。\n"
        "本消息中的【知识库全文】是你唯一可引用的资料（含文字与插图），请**仅依据**其内容回答用户随后提出的问题。\n"
        "\n"
        "硬性规则：\n"
        "1. **基于知识作答**：可归纳、解释、重组步骤，给出可执行的操作说明；禁止编造原文没有的信息。\n"
        "2. **回答结构**（必须遵守）：\n"
        "   - **正文**：自然中文。若插图有助于说明，在对应步骤处**原样插入**知识库中的 Markdown 图片行，"
        "格式为 ![](assets/xxx.png)（路径须与知识库完全一致，每张图单独占一行）。\n"
        "   - **文末引用**：正文结束后空一行，逐行列出来源行号，格式：\n"
        "     【引用】files/agent_{id}/knowledge.md L{起始行}-L{结束行}\n"
        "     单行可写：【引用】files/agent_1/knowledge.md L28\n"
        "     引用须覆盖实际用到的文字行；若该页有「本页插图」，请**另起一行**引用插图行号范围。\n"
        "     只引用你实际用到的段落；可有多行引用。\n"
        "3. **禁止**在正文叙述句中写文件名、行号或【引用】（引用只放在文末专用行）。\n"
        "4. 若知识库足以回答，请直接作答，不要输出「未找到」。\n"
        "5. 仅当知识库完全无法提供任何可回答依据时，才输出：当前知识库中未找到相关信息\n"
        f"{length_rule}"
        f"{extra}"
    )


_MIN_IMAGE_PX = 14


def _read_image_size(path: Path) -> Optional[tuple[int, int]]:
    try:
        from PIL import Image

        with Image.open(path) as im:
            return im.size
    except Exception:
        pass
    try:
        data = path.read_bytes()
        if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
            w, h = struct.unpack(">II", data[16:24])
            return int(w), int(h)
    except Exception:
        pass
    return None


def _prepare_image_bytes(resolved: Path, *, min_px: int = _MIN_IMAGE_PX) -> Optional[tuple[bytes, str]]:
    ext = resolved.suffix.lower()
    if ext not in _IMAGE_EXTS or not resolved.is_file():
        return None
    mime = _IMAGE_MIME.get(ext, "image/png")

    try:
        from PIL import Image

        with Image.open(resolved) as im:
            im.load()
            w, h = im.size
            if min(w, h) < min_px:
                scale = min_px / float(min(w, h))
                nw = max(min_px, int(round(w * scale)))
                nh = max(min_px, int(round(h * scale)))
                resample = getattr(Image, "Resampling", Image).LANCZOS
                im = im.resize((nw, nh), resample)
            buf = io.BytesIO()
            save_fmt = "PNG" if ext == ".png" else (im.format or "PNG")
            im.save(buf, format=save_fmt)
            out_mime = mime if save_fmt.upper() == ext.lstrip(".").upper() else "image/png"
            return buf.getvalue(), out_mime
    except Exception:
        pass

    size = _read_image_size(resolved)
    if size and min(size) < min_px:
        return None
    return resolved.read_bytes(), mime


def _encode_local_image_part(resolved: Path) -> Optional[Dict[str, Any]]:
    prepared = _prepare_image_bytes(resolved)
    if not prepared:
        return None
    raw, mime = prepared
    b64 = base64.b64encode(raw).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def knowledge_to_content_parts(
    *,
    knowledge: str,
    project_root: Path,
    files_dir: str,
    max_images: int = 0,
) -> List[Dict[str, Any]]:
    """Split knowledge markdown into ordered text/image parts for multimodal APIs."""
    parts: List[Dict[str, Any]] = []
    buffer: List[str] = []
    image_count = 0

    def flush_text() -> None:
        if not buffer:
            return
        text = "\n".join(buffer).strip("\n")
        if text:
            parts.append({"type": "text", "text": text})
        buffer.clear()

    for line in (knowledge or "").splitlines():
        img_match = _MD_IMG_RE.search(line)
        if img_match:
            flush_text()
            ref = img_match.group(1)
            alt = line[2 : line.index("](")] if "](" in line else ""
            resolved_rel = resolve_knowledge_asset_path(
                project_root=project_root,
                files_dir=files_dir,
                asset_ref=ref,
            )
            if resolved_rel and (max_images <= 0 or image_count < max_images):
                resolved_path = (project_root / resolved_rel).resolve()
                img_part = _encode_local_image_part(resolved_path)
                if img_part:
                    if alt.strip():
                        parts.append({"type": "text", "text": f"[插图说明] {alt.strip()}"})
                    parts.append(img_part)
                    image_count += 1
                    continue
            buffer.append(line)
            continue
        buffer.append(line)

    flush_text()
    return parts


def format_system_content_for_log(content: Union[str, List[Dict[str, Any]]]) -> str:
    if isinstance(content, str):
        return content
    chunks: List[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text":
            chunks.append(str(part.get("text") or ""))
        elif part.get("type") == "image_url":
            chunks.append("[插图]")
    return "\n".join(chunks)


def count_system_images(content: Union[str, List[Dict[str, Any]]]) -> int:
    if isinstance(content, str):
        return 0
    return sum(1 for p in content if isinstance(p, dict) and p.get("type") == "image_url")


def build_answer_system_content(
    *,
    agent_name: str,
    knowledge: str,
    knowledge_source: str,
    answer_instructions: str,
    project_root: Path,
    files_dir: str,
    max_answer_chars: int = 0,
    include_images: bool = True,
    max_images: int = 0,
) -> Union[str, List[Dict[str, Any]]]:
    """System prompt: rules + full knowledge.md (text and inline images in document order)."""
    source_label = (knowledge_source or "knowledge.md").strip()
    header = (
        _build_answer_rules_text(
            agent_name=agent_name,
            answer_instructions=answer_instructions,
            max_answer_chars=max_answer_chars,
        )
        + f"\n\n【知识库全文】（来源：{source_label}）\n"
    )
    if not include_images:
        return header + (knowledge or "")

    parts: List[Dict[str, Any]] = [{"type": "text", "text": header}]
    parts.extend(
        knowledge_to_content_parts(
            knowledge=knowledge,
            project_root=project_root,
            files_dir=files_dir,
            max_images=max_images,
        )
    )
    return parts


def build_answer_system_message(
    *,
    agent_name: str,
    knowledge: str,
    knowledge_source: str,
    answer_instructions: str,
    max_answer_chars: int = 0,
) -> str:
    """Return rules-only text (legacy helper for tests). Knowledge is no longer appended here."""
    _ = knowledge, knowledge_source
    return _build_answer_rules_text(
        agent_name=agent_name,
        answer_instructions=answer_instructions,
        max_answer_chars=max_answer_chars,
    )


def build_answer_user_message(
    *,
    question: str,
    rewritten_query: str,
    knowledge: str = "",
    knowledge_source: str = "",
    max_retrieval_chars: int = 8000,
) -> tuple[str, List[Citation]]:
    """User message: question only. Full knowledge lives in the system prompt."""
    _ = knowledge, knowledge_source, max_retrieval_chars
    parts: List[str] = [f"用户问题：{question.strip()}"]
    rq = (rewritten_query or "").strip()
    if rq:
        parts.append(f"改写后的查询：{rq}")
    return "\n\n".join(parts), []


def build_verbatim_user_message(*args, **kwargs) -> tuple[str, List[Citation]]:
    """Deprecated alias for build_answer_user_message."""
    return build_answer_user_message(*args, **kwargs)


def is_not_found_answer(text: str) -> bool:
    t = (text or "").strip().rstrip("。").rstrip(".")
    return t == NOT_FOUND_ANSWER


def reconcile_answer_with_retrieval(
    answer: str,
    *,
    knowledge: str,
    retrieval_citations: List[Citation],
    fallback_citations: List[Citation] | None = None,
    max_chars: int = 0,
) -> str:
    """Return model answer as-is (no verbatim snippet backfill)."""
    _ = knowledge, retrieval_citations, fallback_citations, max_chars
    return (answer or "").strip()


def _question_shingles(question: str) -> Set[str]:
    q = (question or "").strip()
    if not q:
        return set()
    stop = {"怎么", "如何", "为什么", "是否", "可以", "不能", "提示", "怎么办", "什么", "哪里", "有没有", "是否能", "怎么做"}
    out: Set[str] = set()
    for i in range(max(0, len(q) - 1)):
        s = q[i : i + 2]
        if not s.strip() or s in stop:
            continue
        if any(ch in "，。！？：；、()（）[]【】{}\"' \t\r\n" for ch in s):
            continue
        out.add(s)
    return out


def _query_terms(query: str) -> Set[str]:
    q = (query or "").strip()
    if not q:
        return set()
    terms: Set[str] = {q}
    for sep in re.split(r"[\s,，。？！？、；;：:]+", q):
        sep = sep.strip()
        if len(sep) >= 2:
            terms.add(sep)
    for n in (2, 3, 4):
        if len(q) < n:
            continue
        for i in range(len(q) - n + 1):
            terms.add(q[i : i + n])
    return terms


_TERM_STOP_ASCII = frozenset(
    {
        "is",
        "at",
        "to",
        "or",
        "an",
        "as",
        "be",
        "by",
        "do",
        "go",
        "if",
        "in",
        "it",
        "me",
        "my",
        "no",
        "of",
        "on",
        "so",
        "up",
        "we",
        "the",
        "what",
        "how",
    }
)


def _score_line(line: str, shingles: Set[str], terms: Set[str] | None = None) -> int:
    if not line.strip():
        return 0
    score = 0
    if terms:
        for term in terms:
            if len(term) < 2:
                continue
            if term.isascii() and len(term) < 3:
                continue
            if term.isascii() and term.lower() in _TERM_STOP_ASCII:
                continue
            if term in line:
                score += max(2, len(term) // 2)
    if not shingles:
        return score
    for sh in shingles:
        if sh in line:
            score += 1
    return score


_FAQ_Q_LINE_RE = re.compile(r"^## Q:\s*")


_FENCE_LINE_RE = re.compile(r"^```[\w-]*\s*$")


def _is_fence_line(line: str) -> bool:
    return bool(_FENCE_LINE_RE.match((line or "").strip()))


def _parse_faq_blocks(lines: List[str]) -> List[tuple[int, int]]:
    """Return (start_line, end_line) 1-based inclusive for each ## Q: ... block."""
    blocks: List[tuple[int, int]] = []
    n = len(lines)
    i = 0
    in_fence = False

    while i < n:
        stripped = lines[i].strip()
        if _is_fence_line(stripped):
            in_fence = not in_fence
            i += 1
            continue
        if not in_fence and _FAQ_Q_LINE_RE.match(stripped):
            start = i + 1
            i += 1
            while i < n:
                s = lines[i].strip()
                if _is_fence_line(s):
                    in_fence = not in_fence
                if _FAQ_Q_LINE_RE.match(s):
                    break
                i += 1
            blocks.append((start, i))
            continue
        i += 1
    return blocks


def _faq_block_containing(line_no: int, blocks: List[tuple[int, int]]) -> tuple[int, int] | None:
    for start, end in blocks:
        if start <= line_no <= end:
            return (start, end)
    return None


def _merge_overlapping_ranges(ranges: List[tuple[int, int, int]]) -> List[tuple[int, int, int]]:
    if not ranges:
        return []
    ordered = sorted(ranges, key=lambda x: x[0])
    merged: List[tuple[int, int, int]] = [ordered[0]]
    for start, end, score in ordered[1:]:
        ls, le, ls_score = merged[-1]
        if start <= le + 2:
            merged[-1] = (ls, max(le, end), ls_score + score)
        else:
            merged.append((start, end, score))
    return sorted(merged, key=lambda x: x[2], reverse=True)


def _expand_ranges_to_faq_blocks(
    ranges: List[tuple[int, int, int]],
    faq_blocks: List[tuple[int, int]],
) -> List[tuple[int, int, int]]:
    expanded: List[tuple[int, int, int]] = []
    for start, end, score in ranges:
        new_start, new_end = start, end
        for ln in range(start, end + 1):
            block = _faq_block_containing(ln, faq_blocks)
            if block:
                new_start = min(new_start, block[0])
                new_end = max(new_end, block[1])
        expanded.append((new_start, new_end, score))
    return _merge_overlapping_ranges(expanded)


def _boost_faq_block_scores(
    scored: List[tuple[int, int]],
    lines: List[str],
    faq_blocks: List[tuple[int, int]],
    shingles: Set[str],
    terms: Set[str],
) -> List[tuple[int, int]]:
    if not faq_blocks:
        return scored
    score_by_line = {ln: sc for ln, sc in scored}
    for start, end in faq_blocks:
        q_score = _score_line(lines[start - 1], shingles, terms)
        if q_score <= 0:
            continue
        boost = q_score + 12
        for ln in range(start, end + 1):
            score_by_line[ln] = max(score_by_line.get(ln, 0), boost)
    return [(ln, score_by_line[ln]) for ln, _ in scored]


def _merge_scored_line_ranges(
    scored_lines: List[tuple[int, int]],
    *,
    gap: int = 2,
) -> List[tuple[int, int, int]]:
    """Merge nearby scored lines into (start, end, total_score) ranges."""
    positive = [(ln, sc) for ln, sc in scored_lines if sc > 0]
    if not positive:
        return []
    positive.sort(key=lambda x: x[0])

    ranges: List[tuple[int, int, int]] = []
    start, end, total = positive[0][0], positive[0][0], positive[0][1]
    prev = positive[0][0]
    for ln, sc in positive[1:]:
        if ln - prev <= gap:
            end = ln
            total += sc
        else:
            ranges.append((start, end, total))
            start, end, total = ln, ln, sc
        prev = ln
    ranges.append((start, end, total))
    return sorted(ranges, key=lambda x: x[2], reverse=True)


def _best_faq_block_in_range(
    *,
    start: int,
    end: int,
    faq_blocks: List[tuple[int, int]],
    lines: List[str],
    shingles: Set[str],
    terms: Set[str],
) -> tuple[int, int] | None:
    best: tuple[int, int] | None = None
    best_q = 0
    for fb_start, fb_end in faq_blocks:
        if fb_end < start or fb_start > end:
            continue
        q_score = _score_line(lines[fb_start - 1], shingles, terms)
        if q_score > best_q:
            best_q = q_score
            best = (fb_start, fb_end)
    return best


def retrieve_knowledge_passages(
    *,
    question: str,
    knowledge: str,
    knowledge_source: str,
    rewritten_query: str = "",
    max_chars: int = 8000,
    max_passages: int = 3,
    context_lines: int = 1,
) -> tuple[str, List[Citation]]:
    """Retrieve verbatim passages for LLM input (internal line markers, not user-facing)."""
    if not (knowledge or "").strip():
        return NOT_FOUND_ANSWER, []

    query_parts = [question.strip(), (rewritten_query or "").strip()]
    query = " ".join(p for p in query_parts if p)
    shingles = _question_shingles(query)
    terms = _query_terms(query)
    lines = knowledge.splitlines()
    if not lines:
        return NOT_FOUND_ANSWER, []

    faq_blocks = _parse_faq_blocks(lines)
    scored = [(i, _score_line(line, shingles, terms)) for i, line in enumerate(lines, start=1)]
    scored = _boost_faq_block_scores(scored, lines, faq_blocks, shingles, terms)
    ranges = _merge_scored_line_ranges(scored)
    ranges = _expand_ranges_to_faq_blocks(ranges, faq_blocks)

    if not ranges:
        return NOT_FOUND_ANSWER, []

    source = (knowledge_source or "knowledge.md").strip()
    limit = max_chars if max_chars > 0 else 8000
    parts: List[str] = []
    citations: List[Citation] = []
    used_chars = 0

    for start, end, _score in ranges[:max_passages]:
        best_block = _best_faq_block_in_range(
            start=start,
            end=end,
            faq_blocks=faq_blocks,
            lines=lines,
            shingles=shingles,
            terms=terms,
        )
        if best_block is not None:
            start, end = best_block
        else:
            start = max(1, start - context_lines)
            end = min(len(lines), end + context_lines)
        body = "\n".join(lines[start - 1 : end]).rstrip()
        if not body:
            continue
        header = f"--- {source} L{start}-L{end} ---"
        block = f"{header}\n{body}"
        if used_chars + len(block) > limit:
            remain = limit - used_chars
            if remain <= len(header) + 4:
                break
            body = body[: max(0, remain - len(header) - 2)].rstrip()
            if not body:
                break
            block = f"{header}\n{body}"
        parts.append(block)
        citations.append(
            Citation(
                file=source,
                page=None,
                line_start=start,
                line_end=end,
                snippet=extract_knowledge_snippet(knowledge=knowledge, line_start=start, line_end=end),
            )
        )
        used_chars += len(block) + 2
        if used_chars >= limit:
            break

    if not parts:
        return NOT_FOUND_ANSWER, []

    return "\n\n---\n\n".join(parts), citations


def retrieve_raw_knowledge_answer(
    *,
    question: str,
    knowledge: str,
    knowledge_source: str,
    rewritten_query: str = "",
    max_chars: int = 8000,
    max_passages: int = 3,
    context_lines: int = 1,
) -> tuple[str, List[Citation]]:
    """Alias kept for tests and backward compatibility."""
    return retrieve_knowledge_passages(
        question=question,
        knowledge=knowledge,
        knowledge_source=knowledge_source,
        rewritten_query=rewritten_query,
        max_chars=max_chars,
        max_passages=max_passages,
        context_lines=context_lines,
    )


def resolve_knowledge_asset_path(*, project_root: Path, files_dir: str, asset_ref: str) -> Optional[str]:
    """Resolve markdown image ref to path relative to data_root.

    Supports:
    - ../assets/foo.png (agent folder knowledge.md)
    - assets/foo.png (u001_whole.md at files root or agents.json cache)
    """
    ref = (asset_ref or "").strip()
    if not ref or ref.startswith(("http://", "https://", "data:")):
        return None

    files_root = (project_root / "files").resolve()
    base = _resolve_dir(project_root, files_dir) if files_dir else project_root

    candidate_paths: list[Path] = []
    for raw in (ref, ref.lstrip("/")):
        try:
            candidate_paths.append((base / raw).resolve())
        except Exception:
            pass
        if raw.startswith("assets/"):
            try:
                candidate_paths.append((files_root / raw).resolve())
            except Exception:
                pass

    seen: set[Path] = set()
    for resolved in candidate_paths:
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved != files_root and files_root not in resolved.parents:
            continue
        if resolved.suffix.lower() not in _MEDIA_EXTS or not resolved.is_file():
            continue
        try:
            return resolved.relative_to(project_root).as_posix()
        except Exception:
            return str(resolved)
    return None


def extract_image_citations_from_knowledge(
    *,
    question: str,
    knowledge: str,
    knowledge_source: str,
    project_root: Path,
    files_dir: str,
    max_items: int = 5,
) -> List[Citation]:
    """
    Pick markdown images from knowledge.md as citations for frontend display.
    Scores by question overlap with alt text and nearby lines.
    """
    if not (knowledge or "").strip():
        return []

    src = (knowledge_source or "knowledge.md").strip()
    shingles = _question_shingles(question)
    lines = knowledge.splitlines()
    recent_text: List[str] = []
    candidates: List[tuple[int, str, str, int | None]] = []

    for line_no, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line:
            continue

        for m in _MD_IMG_RE.finditer(line):
            ref = m.group(1)
            full = m.group(0)
            alt = full[2 : full.index("](")] if "](" in full else ""
            resolved = resolve_knowledge_asset_path(
                project_root=project_root,
                files_dir=files_dir,
                asset_ref=ref,
            )
            if not resolved:
                continue

            context_parts = [alt] + recent_text[-3:]
            context = " ".join(p for p in context_parts if p).strip()
            score = 0
            if shingles:
                for sh in shingles:
                    if sh in context:
                        score += 1
            else:
                score = 1

            snippet = alt.strip() or context[:200] or resolved
            candidates.append((score, resolved, snippet, line_no))

        if line and not _MD_IMG_RE.search(line):
            recent_text.append(line)

    candidates.sort(key=lambda x: x[0], reverse=True)
    out: List[Citation] = []
    seen: set[str] = set()
    for score, file_path, snippet, line_no in candidates:
        if score <= 0:
            continue
        if file_path in seen:
            continue
        seen.add(file_path)
        out.append(
            Citation(
                file=src,
                page=None,
                line_start=line_no,
                line_end=line_no,
                snippet=snippet,
                asset_file=file_path,
            )
        )
        if len(out) >= max_items:
            break

    if not out and candidates:
        for _, file_path, snippet, line_no in candidates[:max_items]:
            if file_path in seen:
                continue
            seen.add(file_path)
            out.append(
                Citation(
                    file=src,
                    page=None,
                    line_start=line_no,
                    line_end=line_no,
                    snippet=snippet,
                    asset_file=file_path,
                )
            )

    return out
