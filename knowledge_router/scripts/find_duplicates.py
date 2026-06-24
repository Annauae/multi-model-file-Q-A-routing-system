#!/usr/bin/env python3
"""用途：扫描重复或高度相似的 FAQ。

检查 questions.json 中问题/回答的完全重复与文本相似度，辅助人工去重。
离线维护工具，不参与 Web 服务运行；常与 consolidate_duplicates.py 配合使用。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATH = ROOT / "knowledge_router" / "files" / "kb_1" / "questions.json"


def norm_q(s: str) -> str:
    s = re.sub(r"[？?。，,\s]", "", s.lower())
    return s


def norm_a(s: str) -> str:
    s = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", s)
    s = re.sub(r"<img[^>]+>", "", s)
    s = re.sub(r"[#*`>|\\-]", "", s)
    s = re.sub(r"\s+", "", s)
    return s


def sim(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PATH
    doc = json.loads(path.read_text(encoding="utf-8"))
    items = doc["items"]
    by_id = {it["id"]: it for it in items}

    print(f"Total items: {len(items)}\n")

    print("=== EXACT/NORMALIZED DUPLICATE QUESTIONS ===")
    seen_q: dict[str, list[str]] = {}
    for it in items:
        seen_q.setdefault(norm_q(it["question"]), []).append(it["id"])
    for _n, ids in sorted(seen_q.items(), key=lambda x: -len(x[1])):
        if len(ids) > 1:
            print(f"  {ids}: {[by_id[i]['question'] for i in ids]}")

    print("\n=== HIGH QUESTION SIMILARITY (>=0.72) ===")
    pairs: list[tuple] = []
    for i, a in enumerate(items):
        for b in items[i + 1 :]:
            r = sim(norm_q(a["question"]), norm_q(b["question"]))
            if r >= 0.72:
                pairs.append((r, a["id"], b["id"]))
    pairs.sort(reverse=True)
    for r, ida, idb in pairs[:40]:
        print(f"  {r:.2f} {ida} vs {idb}")
        print(f"    {by_id[ida]['question']}")
        print(f"    {by_id[idb]['question']}")

    print("\n=== HIGH ANSWER SIMILARITY (>=0.80, norm prefix 400) ===")
    apairs: list[tuple] = []
    for i, a in enumerate(items):
        na = norm_a(a["answer"])[:400]
        for b in items[i + 1 :]:
            nb = norm_a(b["answer"])[:400]
            if len(na) < 40 or len(nb) < 40:
                continue
            r = sim(na, nb)
            if r >= 0.80:
                apairs.append((r, a["id"], b["id"]))
    apairs.sort(reverse=True)
    for r, ida, idb in apairs[:30]:
        print(f"  {r:.2f} {ida} vs {idb}")
        print(f"    Q: {by_id[ida]['question'][:50]}")
        print(f"    Q: {by_id[idb]['question'][:50]}")

    print("\n=== IDENTICAL ANSWERS (full normalized) ===")
    ahash: dict[str, list[str]] = {}
    for it in items:
        h = hashlib.md5(norm_a(it["answer"]).encode()).hexdigest()[:12]
        ahash.setdefault(h, []).append(it["id"])
    for _h, ids in ahash.items():
        if len(ids) > 1:
            print(f"  {ids}: {[by_id[i]['question'][:40] for i in ids]}")

    print("\n=== CROSS-ID TEXT OVERLAP (question/variant same norm) ===")
    variant_map: dict[str, list[str]] = {}
    for it in items:
        for v in [it["question"], *(it.get("variants") or [])]:
            v = v.strip()
            if v:
                variant_map.setdefault(norm_q(v), []).append(it["id"])
    for _n, ids in variant_map.items():
        uniq = sorted(set(ids))
        if len(uniq) > 1:
            print(f"  {uniq}")

    # Topic keyword clusters
    print("\n=== KEYWORD CLUSTERS (same keyword, multiple entries) ===")
    keywords = [
        "模式选择器", "ISO感光度", "曝光补偿", "快门速度", "对焦", "白平衡",
        "测光", "闪光灯", "视频录制", "AUTO", "B门", "遥控B门", "指令拨盘",
        "照片模式", "视频模式", "存储卡", "格式化",
    ]
    for kw in keywords:
        hits = [it["id"] for it in items if kw in it["question"] or kw in it.get("answer", "")[:80]]
        if len(hits) >= 3:
            print(f"  {kw}: {len(hits)} items -> {hits}")


if __name__ == "__main__":
    main()
