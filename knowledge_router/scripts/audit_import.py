#!/usr/bin/env python3
"""用途：审计导入质量。

对比 questions.json 与 model_router 源 Markdown 的标题、插图引用等是否对齐，输出问题报告。
离线维护工具，不参与 Web 服务运行；通常在 import_from_router 之后执行。
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROUTER = ROOT / "model_router" / "files" / "router_1"
QPATH = ROOT / "knowledge_router" / "files" / "kb_1" / "questions.json"
ASSETS = ROOT / "knowledge_router" / "files" / "kb_1" / "assets"

SKIP_HEADINGS = {"本页插图", "page illustration"}


def strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4 :].strip()
    return text.strip()


def md_file_key(path: Path) -> str:
    m = re.search(r"knowledge_p\d+-\d+", path.name)
    return m.group(0) if m else path.stem


def extract_headings(md: str) -> list[tuple[int, str]]:
    body = strip_frontmatter(md)
    out: list[tuple[int, str]] = []
    for line in body.splitlines():
        m = re.match(r"^(#{1,2})\s+(.+?)\s*$", line.strip())
        if m:
            level = len(m.group(1))
            title = re.sub(r"[*_`]", "", m.group(2)).strip()
            title = re.sub(r"^[#🔍✏️✅●■❚\s]+", "", title).strip()
            if title.lower() in SKIP_HEADINGS or title in SKIP_HEADINGS:
                continue
            out.append((level, title))
    return out


def source_assets(md: str) -> set[str]:
    return set(re.findall(r"assets/(knowledge_p[^)\s\"']+\.(?:png|jpe?g|webp|gif))", md, flags=re.I))


def answer_assets(answer: str) -> set[str]:
    return set(re.findall(r"assets/(knowledge_p[^)\s\"']+\.(?:png|jpe?g|webp|gif))", answer, flags=re.I))


def normalize_text(s: str) -> str:
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"\*照相机控制\*|\*页码.*", "", s)
    s = re.sub(r"页脚：.*", "", s)
    s = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", s)
    s = re.sub(r"<img[^>]+>", "", s)
    s = re.sub(r"<svg.*?</svg>", "", s, flags=re.S)
    s = re.sub(r"\s+", "", s)
    return s.lower()


def main() -> None:
    doc = json.loads(QPATH.read_text(encoding="utf-8"))
    items = doc["items"]

    by_key: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        keys = re.findall(r"knowledge_p\d+-\d+", it["answer"])
        key = keys[0] if keys else "unknown"
        by_key[key].append(it)

    disk_assets = {p.name for p in ASSETS.glob("*") if p.is_file()}
    refs: set[str] = set()
    for it in items:
        refs |= answer_assets(it["answer"])
    refs_names = {Path(x).name for x in refs}

    print("=== 总览 ===")
    print(f"FAQ 条目: {len(items)}")
    print(f"源 md 文件: {len(list(ROUTER.glob('agent_*/md/*.md')))}")
    print(f"answer 引用图片: {len(refs_names)} / 磁盘 assets: {len(disk_assets)}")
    print(f"缺失图片: {len(refs_names - disk_assets)}")
    print(f"未引用图片: {len(disk_assets - refs_names)}")

    issues: list[str] = []

    for md_path in sorted(ROUTER.glob("agent_*/md/*.md")):
        key = md_file_key(md_path)
        md = md_path.read_text(encoding="utf-8")
        headings = extract_headings(md)
        h1 = [t for lv, t in headings if lv == 1]
        h2 = [t for lv, t in headings if lv == 2]
        gen = by_key.get(key, [])
        src_imgs = source_assets(md)
        gen_imgs: set[str] = set()
        gen_norm = ""
        for it in gen:
            gen_imgs |= answer_assets(it["answer"])
            gen_norm += normalize_text(it["answer"])

        missing_img = {Path(x).name for x in src_imgs} - {Path(x).name for x in gen_imgs}
        if missing_img:
            issues.append(f"[{key}] 答案缺图 {len(missing_img)}: {sorted(missing_img)[:5]}")

        # rough content coverage: sample long lines from md (>20 chars, not heading)
        body = strip_frontmatter(md)
        key_lines = []
        for line in body.splitlines():
            t = line.strip()
            if not t or t.startswith("#") or t.startswith("<!--") or t.startswith("---"):
                continue
            if t.startswith("!["):
                continue
            if len(re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", t)) < 12:
                continue
            key_lines.append(normalize_text(t)[:80])
        key_lines = list(dict.fromkeys(key_lines))[:15]
        missing_lines = [ln for ln in key_lines if ln and ln not in gen_norm]
        if len(missing_lines) >= 3:
            issues.append(f"[{key}] 可能遗漏正文片段 ({len(missing_lines)}): {missing_lines[0][:50]}…")

        exp_min = max(1, len(h1))
        if len(h2) >= 3 and len(h1) <= 2:
            exp_min = max(exp_min, len(h2) - 2)  # allow some merge
        if len(gen) < exp_min - 1:
            issues.append(
                f"[{key}] 条目偏少: 生成 {len(gen)} 条, h1={len(h1)} h2={len(h2)} "
                f"(agent {md_path.parent.parent.name})"
            )
        if len(gen) > len(h1) + len(h2) + 3:
            issues.append(f"[{key}] 条目偏多: 生成 {len(gen)} 条, h1={len(h1)} h2={len(h2)}")

    for it in items:
        if len(it.get("variants") or []) != 3:
            issues.append(f"[{it['id']}] variants 不是 3 条: {len(it.get('variants') or [])}")
        if not it.get("answer", "").strip():
            issues.append(f"[{it['id']}] answer 为空")
        if not it.get("question", "").strip():
            issues.append(f"[{it['id']}] question 为空")

    dup_q: dict[str, list[str]] = defaultdict(list)
    for it in items:
        dup_q[it["question"].strip()].append(it["id"])
    dups = {q: ids for q, ids in dup_q.items() if len(ids) > 1}
    if dups:
        issues.append(f"重复 question {len(dups)} 组")

    unknown = by_key.get("unknown", [])
    if unknown:
        issues.append(f"无法归属源 md 的条目: {len(unknown)}")

    print("\n=== 各 md 覆盖 (生成条数 | h1 | h2) ===")
    for md_path in sorted(ROUTER.glob("agent_*/md/*.md")):
        key = md_file_key(md_path)
        headings = extract_headings(md_path.read_text(encoding="utf-8"))
        h1 = sum(1 for lv, _ in headings if lv == 1)
        h2 = sum(1 for lv, _ in headings if lv == 2)
        print(f"  {key}: {len(by_key.get(key, [])):>2} | h1={h1} h2={h2} | {md_path.parent.parent.name}")

    print(f"\n=== 问题 ({len(issues)}) ===")
    for x in issues[:40]:
        print(" ", x)
    if len(issues) > 40:
        print(f"  ... 另有 {len(issues)-40} 条")

    # manual spot-check samples written to stdout
    print("\n=== 抽样：agent_2 人像自拍 ===")
    for it in items:
        if "knowledge_p31-35" in it["answer"] and "自拍" in it["question"]:
            print(f"  {it['id']}: {it['question']}")
            print(f"    answer len={len(it['answer'])}, imgs={len(answer_assets(it['answer']))}")


if __name__ == "__main__":
    main()
