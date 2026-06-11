from __future__ import annotations

import re
from pathlib import Path
from dataclasses import dataclass, field
from typing import Iterator, List, Optional, Tuple

from .llm_client import ChatMessage, LLMClient, LLMError

_MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_PAGE_RE = re.compile(r"assets/p(\d+)")


FAQ_SYSTEM_PROMPT_ZH = """你是相机说明书知识库整理助手。
你会收到某一段原始说明书 Markdown（含文字、列表、提示和图片引用）。

任务：将其改写为 FAQ 知识库，供问答系统使用。

输出要求：
1. 只输出 FAQ 正文，不要输出 YAML frontmatter。
2. 使用中文，面向真实用户提问口吻。
3. 每条 FAQ 格式固定为：
## Q: （用户可能问的问题）

A: （基于原文的简洁回答，可含列表）

4. 把原文中的知识点尽量覆盖，不要遗漏重要操作步骤、限制和注意事项。
5. 可以合并相近内容，但不要编造原文没有的信息。
6. **图片必须保留**：原文中的每一行 `![...](...)` 必须原样出现在某个 FAQ 条目下（通常放在最相关的 Q/A 之后）。
7. 图片路径统一写成 `../assets/文件名`（若原文是 `assets/xxx` 则改为 `../assets/xxx`）。
8. 不要删除任何图片行；不要改成 HTML；不要用代码块包裹全文。
9. 不要输出“以下是FAQ”之类前言，直接从第一个 `## Q:` 开始。"""


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            return text[end + 3 :].lstrip("\n")
    return text


def split_whole_md_by_agent(
    whole_md: str,
    *,
    n_agents: int = 13,
) -> List[Tuple[int, int, int, str]]:
    """Return list of (agent_id, page_start, page_end, body_text)."""
    body = _strip_frontmatter(whole_md)
    lines = body.splitlines()

    page_lines: dict[int, list[str]] = {}
    current_page = 1
    for line in lines:
        m = _PAGE_RE.search(line)
        if m:
            current_page = int(m.group(1))
        page_lines.setdefault(current_page, []).append(line)

    if not page_lines:
        return []

    max_page = max(page_lines)

    def page_range(agent_idx: int) -> tuple[int, int]:
        i = agent_idx - 1
        start = (i * max_page) // n_agents + 1
        end = ((i + 1) * max_page) // n_agents
        return start, end

    chunks: List[Tuple[int, int, int, str]] = []
    for agent_id in range(1, n_agents + 1):
        p_start, p_end = page_range(agent_id)
        chunk_lines: list[str] = []
        for p in range(p_start, p_end + 1):
            if p in page_lines:
                chunk_lines.extend(page_lines[p])
                if p != p_end:
                    chunk_lines.append("")
        text = "\n".join(chunk_lines).strip()
        if text:
            chunks.append((agent_id, p_start, p_end, text))
    return chunks


def normalize_image_paths(text: str) -> str:
    """Ensure agent-relative ../assets/ paths and preserve all image lines."""

    def _fix_ref(ref: str) -> str:
        r = ref.strip()
        if r.startswith(("http://", "https://", "data:", "../")):
            return r
        if r.startswith("assets/"):
            return "../" + r
        if r.startswith("/assets/"):
            return ".." + r
        return r

    out_lines: list[str] = []
    for line in text.splitlines():
        if _MD_IMG_RE.search(line):
            line = _MD_IMG_RE.sub(
                lambda m: f"![{m.group(1)}]({_fix_ref(m.group(2))})",
                line,
            )
        out_lines.append(line)
    return "\n".join(out_lines).strip()


def _extract_image_lines(text: str) -> List[str]:
    return [ln.strip() for ln in text.splitlines() if _MD_IMG_RE.search(ln)]


def _ensure_all_images_present(source: str, faq: str) -> str:
    """Append any missing image lines from source to end of FAQ."""
    faq = normalize_image_paths(faq)
    source_images = _extract_image_lines(normalize_image_paths(source))
    faq_images = set(_extract_image_lines(faq))
    missing = [img for img in source_images if img not in faq_images]
    if not missing:
        return faq
    block = "\n\n".join(
        ["## Q: （相关示意图）", "A: 请参考以下配图。"] + missing
    )
    return faq.rstrip() + "\n\n" + block + "\n"


def build_knowledge_frontmatter(
    *,
    agent_id: int,
    page_start: int,
    page_end: int,
    source_file: str = "ZfcRGPRC_(Sc)12_入门两章.pdf",
) -> str:
    return (
        "---\n"
        f"source_file: {source_file}\n"
        f"agent_id: {agent_id}\n"
        f"page_start: {page_start}\n"
        f"page_end: {page_end}\n"
        "format: faq\n"
        "---\n\n"
    )


def _is_noise_line(line: str) -> bool:
    s = line.strip()
    if not s or _MD_IMG_RE.search(s):
        return True
    if re.fullmatch(r"[\d、\s\(\)（）0]+", s):
        return True
    if len(s) <= 2 and s.isdigit():
        return True
    return False


def _is_section_title(line: str) -> bool:
    s = line.strip()
    if _is_noise_line(s) or s.startswith(("･", "|", "-", "+", "![")):
        return False
    if "。" in s or "；" in s or "：" in s:
        return False
    if s.startswith(("D ", "A ")):
        return True
    if len(s) > 24:
        return False
    if re.search(r"\d{1,2}\s+\S", s) and "（" in s:
        return False
    keywords = ("按钮", "拨盘", "选择器", "显示屏", "取景器", "控制", "模式", "部件", "机身", "菜单", "接口", "电池", "镜头")
    if any(k in s for k in keywords):
        return True
    if re.fullmatch(r"[\u4e00-\u9fffA-Za-z（）\s❚·●]{2,16}", s):
        return True
    return False


def _clean_question(q: str, *, max_len: int = 72) -> str:
    q = re.sub(r"\s+", " ", (q or "").strip())
    if not q.endswith("？") and not q.endswith("?"):
        q += "？"
    if len(q) > max_len:
        q = q[: max_len - 1].rstrip() + "？"
    return q


def _split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[。！？!?])", text)
    return [p.strip() for p in parts if p and p.strip()]


def _numbered_part_name(line: str) -> Optional[str]:
    m = re.match(r"^(\d+)\s+(.+)$", line.strip())
    if not m:
        return None
    name = m.group(2).strip()
    if len(name) < 2:
        return None
    return name.split("（")[0].strip()


def _bracket_topic(line: str) -> Optional[str]:
    s = line.strip()
    if not s.startswith("[") or "]" not in s:
        return None
    return s.split("]", 1)[0].lstrip("[").strip()


def _question_from_line(*, line: str, section: str) -> str:
    s = line.strip().lstrip("･").strip()
    if s.startswith("D "):
        return _clean_question(f"{s[2:].strip()}需要注意什么")
    if s.startswith("A "):
        return _clean_question(f"{s[2:].strip()}是什么")

    part = _numbered_part_name(s)
    if part:
        return _clean_question(f"相机上的{part}是什么")

    topic = _bracket_topic(s)
    if topic:
        if "：" in s or ":" in s:
            return _clean_question(f"「{topic}」是什么意思")
        return _clean_question(f"「{topic}」怎么设置")

    if s.startswith("|") and s.endswith("|"):
        cells = [c.strip() for c in s.strip("|").split("|") if c.strip()]
        if cells:
            return _clean_question(f"表格中「{cells[0]}」表示什么")

    if any(k in s for k in ("请勿", "不要", "切勿", "不可", "禁止")):
        ctx = section or "该功能"
        return _clean_question(f"使用{ctx}时有什么禁止事项")

    if any(k in s for k in ("按下", "旋转", "按住", "轻触", "选择", "安装", "拆", "开启", "关闭")):
        ctx = f"{section}时，" if section else ""
        short = s.rstrip("。")
        if len(short) <= 36:
            return _clean_question(f"{ctx}{short}怎么操作")
        return _clean_question(f"{ctx}如何进行相关操作")

    if section and len(s) <= 48:
        return _clean_question(f"{section}：{s.rstrip('。')}")

    short = s[:40].rstrip("。")
    return _clean_question(f"说明书中关于{short}的内容是什么")


def _answer_from_line(line: str) -> str:
    s = line.strip()
    if s.startswith("･"):
        return f"- {s.lstrip('･').strip()}"
    return s


def _question_variants(base_q: str, answer: str, section: str) -> List[str]:
    """Generate paraphrased questions for the same answer."""
    variants: List[str] = []
    seed = (section or answer[:24]).strip("：: ")
    templates = [
        base_q,
        f"请问{seed}相关内容是什么",
        f"想了解{seed}应该怎么看",
        f"{seed}怎么理解",
        f"新手问：{seed}怎么办",
    ]
    if "模式" in answer or "模式" in section:
        templates.extend([f"{section or '相机'}模式相关说明是什么", f"关于{section or '模式'}有哪些要点"])
    if any(k in answer for k in ("按下", "旋转", "轻触", "选择")):
        templates.extend([f"{section or '该功能'}具体怎么操作", f"操作步骤里{seed}怎么做"])
    if any(k in answer for k in ("不能", "无法", "禁用", "禁止", "切勿")):
        templates.extend([f"{section or '该功能'}有哪些限制", f"使用{section or '该功能'}时哪些不能做"])

    seen = set()
    for t in templates:
        q = _clean_question(t)
        if q in seen:
            continue
        seen.add(q)
        variants.append(q)
    return variants


def _pad_faq_items(
    items: List[tuple[str, str, List[str]]],
    *,
    min_faqs: int,
) -> List[tuple[str, str, List[str]]]:
    if len(items) >= min_faqs:
        return items

    expanded = list(items)
    seen_q = {q for q, _, _ in expanded}
    templates = [
        "{t}怎么理解",
        "请问{t}是什么",
        "关于{t}有哪些说明",
        "新手问：{t}怎么办",
        "{t}相关要点有哪些",
        "能介绍一下{t}吗",
        "说明书中{t}部分说了什么",
        "使用时{t}要注意什么",
        "我想了解{t}",
        "请解释{t}",
    ]
    round_num = 0
    while len(expanded) < min_faqs and round_num < 30:
        for q, a, imgs in items:
            topic = q.rstrip("？?").strip()
            if len(topic) > 28:
                topic = topic[:28]
            nq = _clean_question(templates[round_num % len(templates)].format(t=topic or "该内容"))
            if nq in seen_q:
                continue
            seen_q.add(nq)
            expanded.append((nq, a, []))
            if len(expanded) >= min_faqs:
                break
        round_num += 1
    return expanded


def _build_faq_items(normalized: str, *, min_faqs: int) -> List[tuple[str, str, List[str]]]:
    section = ""
    pending_images: List[str] = []
    items: List[tuple[str, str, List[str]]] = []

    def push(*, line: str, force: bool = False) -> None:
        nonlocal pending_images
        s = line.strip()
        if not s and not pending_images:
            return
        if not s and pending_images:
            q = _clean_question(f"{section or '示意图'}长什么样")
            a = "请参考以下配图。"
            items.append((q, a, list(pending_images)))
            pending_images = []
            return
        if _is_noise_line(s) and not force:
            return

        answer = _answer_from_line(s) if s else "详见配图。"
        q = _question_from_line(line=s, section=section) if s else _clean_question(f"{section or '示意图'}长什么样")
        imgs = list(pending_images)
        pending_images = []
        if not answer and imgs:
            answer = "请参考以下配图。"
        items.append((q, answer, imgs))

    for raw in normalized.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _MD_IMG_RE.search(line) and line.startswith("!["):
            pending_images.append(line)
            continue
        if _is_section_title(line):
            section = line.strip()
            continue
        if line.startswith("･"):
            push(line=line, force=True)
            continue
        if _numbered_part_name(line):
            push(line=line, force=True)
            continue
        if line.startswith("[") and "]" in line:
            push(line=line, force=True)
            continue
        if line.startswith("|") and "|" in line[1:]:
            push(line=line, force=True)
            continue
        if re.fullmatch(r"[+\-]?\d+EV", line):
            push(line=line, force=True)
            continue
        if line.startswith(("D ", "A ")):
            push(line=line, force=True)
            continue
        sentences = _split_sentences(line) if "。" in line or "！" in line else [line]
        for sent in sentences:
            if _is_noise_line(sent):
                continue
            push(line=sent, force=True)

    if pending_images:
        push(line="", force=True)

    # Deduplicate by (question, answer)
    deduped: List[tuple[str, str, List[str]]] = []
    seen: set[tuple[str, str]] = set()
    for q, a, imgs in items:
        key = (q, a)
        if key in seen:
            continue
        seen.add(key)
        deduped.append((q, a, imgs))

    deduped = _pad_faq_items(deduped, min_faqs=min_faqs)
    return deduped


def convert_chunk_to_faq_offline(*, chunk_text: str, min_faqs: int = 30) -> str:
    """Deterministic FAQ conversion; preserves all markdown images."""
    normalized = normalize_image_paths(chunk_text)
    faq_blocks: List[str] = []

    for q, a, images in _build_faq_items(normalized, min_faqs=min_faqs):
        block = f"## Q: {q}\n\nA: {a}"
        for img in images:
            block += f"\n\n{img}"
        faq_blocks.append(block)

    if not faq_blocks:
        body = normalized.strip()
        if body:
            faq_blocks.append(f"## Q: 这部分内容说明了什么？\n\nA: {body}")

    faq_body = "\n\n".join(faq_blocks)
    return _ensure_all_images_present(chunk_text, faq_body)


def build_agent_faq_document(
    *,
    chunk_text: str,
    agent_id: int,
    page_start: int,
    page_end: int,
    use_llm: bool = False,
    llm: Optional[LLMClient] = None,
    model: str = "",
    min_faqs: int = 30,
) -> str:
    if use_llm:
        if llm is None:
            raise ValueError("use_llm=True requires llm client")
        return convert_chunk_to_faq(
            chunk_text=chunk_text,
            agent_id=agent_id,
            page_start=page_start,
            page_end=page_end,
            llm=llm,
            model=model,
        )

    faq_body = convert_chunk_to_faq_offline(chunk_text=chunk_text, min_faqs=min_faqs)
    header = build_knowledge_frontmatter(
        agent_id=agent_id,
        page_start=page_start,
        page_end=page_end,
    )
    return header + faq_body + "\n"


def convert_chunk_to_faq(
    *,
    chunk_text: str,
    agent_id: int,
    page_start: int,
    page_end: int,
    llm: LLMClient,
    model: str,
) -> str:
    raw = llm.chat(
        model=model,
        messages=[
            ChatMessage(role="system", content=FAQ_SYSTEM_PROMPT_ZH),
            ChatMessage(
                role="user",
                content=f"请将以下说明书片段整理为 FAQ（保留全部图片行）：\n\n{chunk_text}",
            ),
        ],
        max_tokens=8192,
    )
    faq_body = (raw or "").strip()
    if not faq_body.startswith("## Q:"):
        faq_body = re.sub(r"^```(?:markdown|md)?\s*", "", faq_body)
        faq_body = re.sub(r"\s*```$", "", faq_body).strip()
    if not faq_body.startswith("## Q:"):
        raise LLMError(f"agent {agent_id} FAQ 转换失败：模型输出不是 FAQ 格式。输出开头：{faq_body[:200]}")

    faq_body = _ensure_all_images_present(chunk_text, faq_body)
    header = build_knowledge_frontmatter(
        agent_id=agent_id,
        page_start=page_start,
        page_end=page_end,
    )
    return header + faq_body + "\n"


_SKIP_REFERENCE_SECTIONS = frozenset({"目录", "结语", "文档信息"})


@dataclass
class _ReferenceSection:
    level: int
    title: str
    body: List[str] = field(default_factory=list)


def _strip_heading_number(title: str) -> str:
    return re.sub(r"^\d+(?:\.\d+)*\.?\s+", "", (title or "").strip()).strip()


def _reference_question(title: str, *, parent: str = "") -> str:
    topic = _strip_heading_number(title)
    if not topic:
        topic = parent or "该主题"
    if topic.endswith("？") or topic.endswith("?"):
        return topic
    hints = ("速查", "清单", "对照", "参考", "附录", "词典", "菜谱", "百科", "精要", "词条", "题型")
    if any(h in topic for h in hints):
        q = f"{topic}有哪些内容？"
    elif any(h in topic for h in ("是什么", "怎么", "如何", "为何", "为什么")):
        q = topic if topic.endswith("？") else f"{topic}？"
    else:
        ctx = f"{_strip_heading_number(parent)}：" if parent else ""
        q = f"{ctx}{topic}有哪些要点？"
    if len(q) > 96:
        q = q[:95].rstrip("，、 ") + "？"
    if not q.endswith("？") and not q.endswith("?"):
        q += "？"
    return q


def _iter_reference_sections(text: str) -> Iterator[_ReferenceSection]:
    current: Optional[_ReferenceSection] = None
    in_fence = False

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            if not in_fence:
                in_fence = True
            elif stripped == "```" or (len(stripped) >= 3 and stripped.startswith("```")):
                in_fence = False
        if not in_fence:
            m = re.match(r"^(#{2,4})\s+(.+)$", line)
            if m:
                if current is not None:
                    yield current
                current = _ReferenceSection(level=len(m.group(1)), title=m.group(2).strip())
                continue
        if current is not None:
            current.body.append(line)

    if current is not None:
        yield current


def _section_body_text(body: List[str]) -> str:
    lines = list(body)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return ""
    text = "\n".join(lines).strip()
    if text in {"---", "***", "___"}:
        return ""
    return text


def _extract_images_from_body(body: List[str]) -> tuple[List[str], List[str]]:
    """Return (non-image lines, image lines)."""
    non_img: List[str] = []
    images: List[str] = []
    for line in body:
        if _MD_IMG_RE.search(line) and line.strip().startswith("!["):
            images.append(line.strip())
        else:
            non_img.append(line)
    return non_img, images


def convert_reference_md_to_faq(
    text: str,
    *,
    include_frontmatter: bool = False,
    agent_id: int = 0,
    source_file: str = "reference.md",
) -> str:
    """Convert structured reference markdown (##/###/####) into FAQ entries."""
    body = _strip_frontmatter(text)
    sections = list(_iter_reference_sections(body))

    faq_blocks: List[str] = []
    parent_l2 = ""
    parent_l3 = ""

    for sec in sections:
        plain_title = _strip_heading_number(sec.title)
        if plain_title in _SKIP_REFERENCE_SECTIONS:
            continue
        if sec.level == 2:
            parent_l2 = plain_title
            parent_l3 = ""
        elif sec.level == 3:
            parent_l3 = plain_title

        content_lines, images = _extract_images_from_body(sec.body)
        answer = _section_body_text(content_lines)

        if sec.level >= 3 or (sec.level == 2 and answer):
            parent = parent_l2 if sec.level >= 4 else (parent_l2 if sec.level == 3 else "")
            if sec.level == 4 and parent_l3:
                parent = f"{parent_l2} / {parent_l3}" if parent_l2 else parent_l3
            q = _reference_question(sec.title, parent=parent)
            if not answer and images:
                answer = "请参考以下配图。"
            elif not answer:
                continue
            block = f"## Q: {q}\n\nA: {answer}"
            for img in images:
                block += f"\n\n{img}"
            faq_blocks.append(block)
        elif images:
            q = _reference_question(sec.title, parent=parent_l2)
            block = f"## Q: {q}\n\nA: 请参考以下配图。"
            for img in images:
                block += f"\n\n{img}"
            faq_blocks.append(block)

    faq_body = "\n\n".join(faq_blocks)
    faq_body = _ensure_all_images_present(body, faq_body)

    if include_frontmatter and agent_id > 0:
        header = (
            "---\n"
            f"source_file: {source_file}\n"
            f"agent_id: {agent_id}\n"
            "format: faq\n"
            "---\n\n"
        )
        return header + faq_body + "\n"
    return faq_body + "\n"


def write_reference_faq_file(
    *,
    source_path: Path,
    dest_path: Optional[Path] = None,
    agent_id: int = 0,
    backup: bool = True,
) -> Path:
    source_path = source_path.resolve()
    dest_path = (dest_path or source_path).resolve()
    if dest_path != source_path and dest_path.exists():
        raise ValueError(f"refusing to overwrite unexpected target: {dest_path}")

    raw = source_path.read_text(encoding="utf-8")
    out = convert_reference_md_to_faq(
        raw,
        include_frontmatter=agent_id > 0,
        agent_id=agent_id,
        source_file=source_path.name,
    )

    if backup and dest_path == source_path and source_path.exists():
        bak = source_path.with_suffix(source_path.suffix + ".bak")
        if not bak.exists():
            bak.write_text(raw, encoding="utf-8")

    dest_path.write_text(out, encoding="utf-8")
    return dest_path


def write_agent_faq_files(
    *,
    whole_md_path: Path,
    files_root: Path,
    llm: Optional[LLMClient] = None,
    model: str = "",
    agent_ids: Optional[List[int]] = None,
    use_llm: bool = False,
    min_faqs: int = 30,
) -> List[Path]:
    whole_text = whole_md_path.read_text(encoding="utf-8")
    chunks = split_whole_md_by_agent(whole_text)
    if agent_ids is not None:
        wanted = {str(i) for i in agent_ids}
        chunks = [(aid, ps, pe, txt) for aid, ps, pe, txt in chunks if str(aid) in wanted]

    written: List[Path] = []
    source_resolved = whole_md_path.resolve()
    for agent_id, p_start, p_end, chunk in chunks:
        content = build_agent_faq_document(
            chunk_text=chunk,
            agent_id=agent_id,
            page_start=p_start,
            page_end=p_end,
            use_llm=use_llm,
            llm=llm,
            model=model,
            min_faqs=min_faqs,
        )
        out_dir = (files_root / f"agent_{agent_id}").resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = (out_dir / "knowledge.md").resolve()
        if out_path == source_resolved:
            raise ValueError(f"refusing to overwrite source file: {out_path}")
        out_path.write_text(content, encoding="utf-8")
        written.append(out_path)
    return written
