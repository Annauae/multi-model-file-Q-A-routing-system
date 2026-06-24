#!/usr/bin/env python3
"""用途：修正 answer 开头标题。

确保每条 FAQ 回答以对应源文档章节标题（#/##/###）起头，与 router Markdown 对齐。
离线维护工具，不参与 Web 服务运行；会直接修改 questions.json。
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

ROOT = Path(__file__).resolve().parents[2]
ROUTER = ROOT / "model_router" / "files" / "router_1"
QPATH = ROOT / "knowledge_router" / "files" / "kb_1" / "questions.json"

SKIP_HEADINGS = {"本页插图", "page illustration"}


def strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4 :].strip()
    return text.strip()


def normalize_text(s: str) -> str:
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", s)
    s = re.sub(r"<img[^>]+>", "", s, flags=re.I)
    s = re.sub(r"<svg.*?</svg>", "", s, flags=re.S)
    s = re.sub(r"[*_`#>|]", "", s)
    s = re.sub(r"\s+", "", s)
    return s.lower()


def clean_heading(title: str) -> str:
    t = (title or "").strip()
    t = re.sub(r"^[#🔍✏️✅●■❚🖋️📝☑️\s]+", "", t)
    return t.strip()


def extract_assets(text: str) -> Set[str]:
    found = set(re.findall(r"assets/(knowledge_p[^)\s\"']+\.(?:png|jpe?g|webp|gif))", text, flags=re.I))
    return {Path(x).name for x in found}


def heading_line(level: int, title: str) -> str:
    return f"{'#' * level} {title}"


def answer_has_heading(answer: str, level: int, title: str) -> bool:
    body = (answer or "").lstrip()
    want = heading_line(level, title)
    if body.startswith(want):
        return True
    # also accept emoji-prefixed variants in answer
    first_line = body.split("\n", 1)[0].strip()
    norm_first = normalize_text(first_line)
    norm_title = normalize_text(title)
    if norm_title and norm_title in norm_first:
        return first_line.startswith("#")
    return False


@dataclass
class Section:
    file_key: str
    level: int
    title: str
    body: str
    assets: Set[str]

    @property
    def norm_body(self) -> str:
        return normalize_text(self.body)


def parse_md_sections(md_path: Path) -> List[Section]:
    key = re.search(r"knowledge_p\d+-\d+", md_path.name)
    file_key = key.group(0) if key else md_path.stem
    body = strip_frontmatter(md_path.read_text(encoding="utf-8"))
    sections: List[Section] = []
    cur_level = 0
    cur_title = ""
    cur_lines: List[str] = []

    def flush() -> None:
        nonlocal cur_lines, cur_title, cur_level
        if not cur_title:
            cur_lines = []
            return
        if clean_heading(cur_title) in SKIP_HEADINGS:
            cur_lines = []
            return
        text = "\n".join(cur_lines).strip()
        if not text and not cur_lines:
            cur_lines = []
            return
        sections.append(
            Section(
                file_key=file_key,
                level=cur_level,
                title=cur_title,
                body=text,
                assets=extract_assets(text),
            )
        )
        cur_lines = []

    for line in body.splitlines():
        m = re.match(r"^(#{1,3})\s+(.+?)\s*$", line.strip())
        if m:
            flush()
            cur_level = len(m.group(1))
            cur_title = m.group(2).strip()
            continue
        cur_lines.append(line)
    flush()
    return sections


def score_section_match(answer: str, section: Section) -> float:
    ans_assets = extract_assets(answer)
    if ans_assets and section.assets:
        overlap = len(ans_assets & section.assets)
        if overlap:
            return 100.0 + overlap * 10 + len(ans_assets & section.assets) / max(len(ans_assets), 1)
    ans_norm = normalize_text(answer)
    sec_norm = section.norm_body
    if not ans_norm or not sec_norm:
        return 0.0
    if sec_norm in ans_norm:
        return 50.0 + min(len(sec_norm), len(ans_norm)) / 1000
    if ans_norm in sec_norm:
        return 40.0 + min(len(ans_norm), len(sec_norm)) / 1000
    # prefix overlap
    probe = ans_norm[: min(120, len(ans_norm))]
    if probe and probe in sec_norm:
        return 30.0
    # shared chunk
    common = 0
    for n in (80, 60, 40):
        chunk = ans_norm[:n]
        if len(chunk) >= 20 and chunk in sec_norm:
            common = n
            break
    if common:
        return 20.0 + common / 10
    return 0.0


def best_section(answer: str, sections: List[Section]) -> Optional[Section]:
    scored = [(score_section_match(answer, s), s) for s in sections]
    scored = [(sc, s) for sc, s in scored if sc > 0]
    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    top_score, top = scored[0]
    if len(scored) > 1 and scored[1][0] == top_score:
        # tie-break: more asset overlap
        return top
    if top_score < 15:
        return None
    return top


def main() -> None:
    all_sections: List[Section] = []
    for md in sorted(ROUTER.glob("agent_*/md/*.md")):
        all_sections.extend(parse_md_sections(md))

    doc = json.loads(QPATH.read_text(encoding="utf-8"))
    items = doc["items"]

    fixed: List[str] = []
    skipped_has: List[str] = []
    unmatched: List[str] = []

    for it in items:
        iid = it["id"]
        answer = it.get("answer") or ""
        sec = best_section(answer, all_sections)
        if sec is None:
            unmatched.append(iid)
            continue
        title = clean_heading(sec.title)
        if not title:
            unmatched.append(iid)
            continue
        if answer_has_heading(answer, sec.level, sec.title) or answer_has_heading(answer, sec.level, title):
            skipped_has.append(iid)
            continue
        # use original title from md (keeps emoji/prefixes like ●)
        new_answer = heading_line(sec.level, sec.title) + "\n" + answer.lstrip()
        it["answer"] = new_answer
        fixed.append(f"{iid} <- {sec.file_key} {heading_line(sec.level, sec.title)}")

    QPATH.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report = ROOT / "knowledge_router" / "scripts" / "fix_headings_report.txt"
    lines = [
        f"total items: {len(items)}",
        f"already had heading: {len(skipped_has)}",
        f"fixed: {len(fixed)}",
        f"unmatched: {len(unmatched)}",
        "",
        "=== fixed ===",
        *fixed,
        "",
        "=== unmatched ===",
        *unmatched,
    ]
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:20]))
    print(f"... report: {report}")


if __name__ == "__main__":
    main()
