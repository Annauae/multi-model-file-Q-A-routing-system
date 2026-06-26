"""PDF 导入：按标题切分与 LLM 智能合并。"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List

from .llm_client import ChatMessage, LLMClient, LLMError, TokenUsageResult
from .questions_import import strip_md_frontmatter

_PAGE_MARKER_RE = re.compile(r"<!--\s*page\s+(\d+)\s*-->", re.I)
_HEADER_RE = re.compile(r"^(#{1,2})\s+(.+)$", re.M)
_HEADING_LINE_RE = re.compile(r"^#{1,6}\s+")
_PLACEHOLDER_TITLES = frozenset({"前言", "序言", "本页插图", "插图", "插图说明", "目录"})

MERGE_SECTIONS_PROMPT = """你是文档结构分析器。给定按顺序排列的 Markdown 章节片段，判断哪些相邻章节应合并为一条 FAQ。

规则（拆分优先）：
1. 每个内容充实、能独立成问答的 `##` 二级标题默认单独成块，不要合并。
2. 仅当相邻章节属于同一不可分割的操作步骤链、拆分后会丢失完整语义时才合并。
3. 主题相关但各自可独立回答的章节（如不同模式 M/A/C、不同故障现象、不同功能说明）必须拆分。
4. 跳过「本页插图」等无实质内容的占位章节（可与相邻合并或单独丢弃）。
5. 输出 JSON 数组，每个元素为 {"indices": [0], "title": "章节标题"}，indices 为输入章节下标（从 0 开始），通常只含 1 个下标；仅强关联时才含多个连续下标。
6. 所有章节必须被恰好覆盖一次，不能遗漏或重复。

只输出 JSON 数组，不要 Markdown 代码块。"""


@dataclass
class MarkdownSection:
    title: str
    markdown: str
    page_start: int = 0
    page_end: int = 0


def _extract_first_json_array(text: str) -> str:
    s = (text or "").strip()
    start = s.find("[")
    end = s.rfind("]")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("模型输出不包含 JSON 数组")
    return s[start : end + 1]


def split_by_headers(md_text: str) -> List[MarkdownSection]:
    """按 # / ## 标题切分为候选章节。"""
    text = (md_text or "").strip()
    if not text:
        return []
    page_nums = [int(m.group(1)) for m in _PAGE_MARKER_RE.finditer(text)]
    default_page = page_nums[0] if page_nums else 0

    lines = text.splitlines()
    sections: List[MarkdownSection] = []
    cur_title = "前言"
    cur_lines: List[str] = []
    cur_page = default_page

    def flush() -> None:
        body = "\n".join(cur_lines).strip()
        if body:
            sections.append(
                MarkdownSection(
                    title=cur_title.strip(),
                    markdown=body,
                    page_start=cur_page,
                    page_end=cur_page,
                )
            )

    for line in lines:
        pm = _PAGE_MARKER_RE.match(line.strip())
        if pm:
            cur_page = int(pm.group(1))
            cur_lines.append(line)
            continue
        hm = _HEADER_RE.match(line)
        if hm:
            flush()
            cur_title = hm.group(2).strip()
            cur_lines = [line]
        else:
            cur_lines.append(line)
    flush()
    out = []
    for s in sections:
        body = re.sub(r"<!--\s*page\s+\d+\s*-->", "", s.markdown, flags=re.I).strip()
        if s.title == "前言" and not body:
            continue
        out.append(s)
    return out if out else sections


def _section_substantive_text(section_md: str) -> str:
    """去掉标题、页标记、图片后剩余的正文。"""
    text = strip_md_frontmatter(section_md or "")
    text = _PAGE_MARKER_RE.sub("", text)
    parts: List[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or _HEADING_LINE_RE.match(line):
            continue
        line = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", line)
        line = re.sub(r"\[([^\]]*)\]\([^)]+\)", r"\1", line)
        parts.append(line)
    merged = " ".join(parts)
    return re.sub(r"[*_~`>|\\-]", "", merged).strip()


def is_trivial_section(section_md: str, section_title: str = "") -> bool:
    """章节是否无实质正文（如仅「## 前言」），无需调用 FAQ 模型。"""
    text = strip_md_frontmatter(section_md or "")
    text = _PAGE_MARKER_RE.sub("", text).strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    content_lines = [ln for ln in lines if not _HEADING_LINE_RE.match(ln)]
    substantive = _section_substantive_text(section_md)
    if substantive:
        return False
    title = (section_title or "").strip()
    if title in _PLACEHOLDER_TITLES:
        return True
    if len(lines) <= 1 and lines and _HEADING_LINE_RE.match(lines[0]):
        return True
    return not content_lines


def filter_meaningful_sections(sections: List[MarkdownSection]) -> tuple[List[MarkdownSection], List[MarkdownSection]]:
    """拆出有效章节与应跳过的无实质内容章节。"""
    kept: List[MarkdownSection] = []
    skipped: List[MarkdownSection] = []
    for sec in sections:
        if is_trivial_section(sec.markdown, sec.title):
            skipped.append(sec)
        else:
            kept.append(sec)
    return kept, skipped


def merge_sections_with_llm(
    sections: List[MarkdownSection],
    *,
    llm: LLMClient,
    import_model: str,
) -> tuple[List[MarkdownSection], TokenUsageResult]:
    """LLM 决定相邻章节合并，返回最终 section 列表。"""
    empty_usage = TokenUsageResult()
    if len(sections) <= 1:
        return sections, empty_usage
    payload = [
        {"index": i, "title": s.title, "preview": s.markdown[:400], "pages": [s.page_start, s.page_end]}
        for i, s in enumerate(sections)
    ]
    raw, usage = llm.chat(
        model=import_model,
        messages=[
            ChatMessage(role="system", content=MERGE_SECTIONS_PROMPT),
            ChatMessage(role="user", content=json.dumps(payload, ensure_ascii=False)),
        ],
        max_tokens=4096,
        temperature=0.1,
    )
    try:
        groups = json.loads(_extract_first_json_array(raw))
    except Exception as e:  # noqa: BLE001
        raise LLMError(f"章节合并解析失败：{e}") from e
    if not isinstance(groups, list):
        raise LLMError("章节合并输出必须是数组")
    merged: List[MarkdownSection] = []
    used: set[int] = set()
    for g in groups:
        if not isinstance(g, dict):
            continue
        idxs = g.get("indices", [])
        if not isinstance(idxs, list) or not idxs:
            continue
        valid = [int(i) for i in idxs if isinstance(i, (int, float, str)) and 0 <= int(i) < len(sections)]
        if not valid:
            continue
        for i in valid:
            used.add(i)
        parts = [sections[i].markdown for i in valid]
        pages = [sections[i].page_start for i in valid] + [sections[i].page_end for i in valid]
        title = str(g.get("title", sections[valid[0]].title)).strip() or sections[valid[0]].title
        merged.append(
            MarkdownSection(
                title=title,
                markdown="\n\n".join(parts),
                page_start=min(pages) if pages else 0,
                page_end=max(pages) if pages else 0,
            )
        )
    if len(used) < len(sections):
        for i, s in enumerate(sections):
            if i not in used:
                merged.append(s)
    return (merged if merged else sections), usage


def sectionize_markdown(
    md_text: str,
    *,
    llm: LLMClient,
    import_model: str,
    on_progress: Callable[[str], None] | None = None,
) -> tuple[List[MarkdownSection], TokenUsageResult]:
    if on_progress:
        on_progress("[step] 按标题切分 Markdown…")
    sections = split_by_headers(md_text)
    if not sections:
        raise LLMError("Markdown 无有效章节")
    if on_progress:
        on_progress(f"[step] 共 {len(sections)} 个候选章节，LLM 合并/拆分…")
    return merge_sections_with_llm(sections, llm=llm, import_model=import_model)
