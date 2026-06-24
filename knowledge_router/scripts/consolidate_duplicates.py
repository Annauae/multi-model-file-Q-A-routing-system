#!/usr/bin/env python3
"""用途：合并重复 FAQ 条目。

按预设规则合并相似问题（合并 variants、删除冗余条目），直接改写 kb_1/questions.json。
离线维护工具，不参与 Web 服务运行；建议先运行 find_duplicates.py 确认范围。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QPATH = ROOT / "knowledge_router" / "files" / "kb_1" / "questions.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_q(s: str) -> str:
    return re.sub(r"[？?。，,\s]", "", s.lower())


def merge_variants(*groups: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for group in groups:
        for v in group:
            v = (v or "").strip()
            if not v:
                continue
            key = norm_q(v)
            if key in seen:
                continue
            seen.add(key)
            out.append(v)
    return out


def by_id(items: list[dict]) -> dict[str, dict]:
    return {it["id"]: it for it in items}


def main() -> None:
    doc = json.loads(QPATH.read_text(encoding="utf-8"))
    items = doc["items"]
    m = by_id(items)
    actions: list[str] = []

    # --- q001 absorbs q139 (模式选择器 duplicate) ---
    q001 = m["q001"]
    q139 = m["q139"]
    q001["variants"] = merge_variants(
        q001.get("variants", []),
        q139.get("variants", []),
        [q139["question"]],
    )
    q001["answer"] = (
        "# 模式选择器\n"
        "使用模式选择器可选择一种拍摄模式。\n\n"
        "![模式选择器示意图](assets/knowledge_p28-30_001.png)\n\n"
        "| 模式 | 说明 |\n"
        "|------|------|\n"
        "| AUTO 自动 | 一种简单的“即取即拍”模式，由照相机控制设定（❏104、❏109）。 |\n"
        "| P 程序自动 | 由照相机设定快门速度和光圈以获得良好曝光。 |\n"
        "| S 快门优先自动 | 用于锁定或模糊动作。由您选择快门速度；照相机选择光圈以达到良好效果。 |\n"
        "| A 光圈优先自动 | 用于模糊背景，或使前景和背景都清晰对焦。由您选择光圈；照相机选择快门速度以达到良好效果。 |\n"
        "| M 手动 | 快门速度和光圈都由您控制。将快门速度设为“B门”或“遥控B门”可实现长时间曝光。 |"
    )
    q001["updated_at"] = now_iso()
    q139["enabled"] = False
    q139["updated_at"] = now_iso()
    actions.append("q139 → merged into q001 (模式选择器), q139 disabled")

    # --- q007 absorbs q156 (identical question, richer answer in q156) ---
    q007 = m["q007"]
    q156 = m["q156"]
    q007["variants"] = merge_variants(q007.get("variants", []), q156.get("variants", []))
    q007["answer"] = q156["answer"].replace("使用该按钮可更改", "旋转曝光补偿拨盘可更改")
    q007["updated_at"] = now_iso()
    q156["enabled"] = False
    q156["updated_at"] = now_iso()
    actions.append("q156 → merged into q007 (曝光补偿拨盘), q156 disabled")

    # --- q005 absorbs q153 (photo mode ISO) ---
    q005 = m["q005"]
    q153 = m["q153"]
    q005["variants"] = merge_variants(
        q005.get("variants", []),
        q153.get("variants", []),
        [q153["question"]],
    )
    q005["answer"] = (
        "## ❚❚ 照片模式\n"
        "通过按住ISO感光度拨盘锁定解除并旋转ISO感光度拨盘，可以调节ISO感光度。\n\n"
        "- 从ISO 100至51200的值中进行选择。可以将ISO感光度拨盘设为**[H1]（Hi 1）**"
        "或**[H2]（Hi 2）**以分别获得高于ISO 51200约1或2步长的感光度。\n"
        "- 在AUTO模式下，设定固定为**ISO-A (AUTO)**，照相机自动设定ISO感光度。\n\n"
        "若在照片拍摄菜单中将**[静音拍摄]**设为**[开启]**，则无法使用ISO感光度"
        "**[H1]（Hi 1）**和**[H2]（Hi 2）**。若将ISO感光度拨盘设为**[H1]**或**[H2]**，"
        "ISO感光度将设为ISO 51200。\n\n"
        "---\n\n"
        "✏️ **拍摄照片时的ISO感光度自动控制**\n\n"
        "若在照片拍摄菜单中将**[ISO感光度设定]**（☞282）> **[ISO感光度自动控制]**"
        "设为**[开启]**，当使用在模式P、S、A和M下设定的ISO感光度无法获得正确的曝光时，"
        "照相机将自动更改ISO感光度。"
    )
    q005["updated_at"] = now_iso()
    q153["enabled"] = False
    q153["updated_at"] = now_iso()
    actions.append("q153 → merged into q005 (照片模式 ISO), q153 disabled")

    # --- q006 absorbs q154 (video mode ISO) ---
    q006 = m["q006"]
    q154 = m["q154"]
    q006["variants"] = merge_variants(
        q006.get("variants", []),
        q154.get("variants", []),
        [q154["question"]],
    )
    q006["answer"] = (
        "## ❚❚ 视频模式\n"
        "您只能在以下设定时设定ISO感光度。在所有其他情况下，照相机都会自动设定ISO感光度。\n"
        "- 模式：**M**\n"
        "- 视频拍摄菜单中的`[ISO感光度设定]>[自动ISO控制(M模式)]`：`[关闭]`\n\n"
        "通过按住ISO感光度拨盘锁定解除并旋转ISO感光度拨盘，可以调节ISO感光度。\n"
        "- 从ISO 100至25600的值中进行选择。如果将ISO感光度拨盘设为任意其他值，"
        "ISO感光度将设为**ISO 25600**。"
    )
    q006["updated_at"] = now_iso()
    q154["enabled"] = False
    q154["updated_at"] = now_iso()
    actions.append("q154 → merged into q006 (视频模式 ISO), q154 disabled")

    # --- q004 absorbs q152 (ISO dial basics) ---
    q004 = m["q004"]
    q152 = m["q152"]
    q004["variants"] = merge_variants(
        q004.get("variants", []),
        q152.get("variants", []),
        [q152["question"]],
    )
    q004["answer"] = (
        "# ISO感光度拨盘\n"
        "照相机对光线的灵敏度（ISO感光度）可根据可用光线量进行调整。"
        "一般情况下，选择的值越高，在相同光圈下可使用的快门速度越快。\n\n"
        "在按住ISO感光度拨盘锁定解除的同时旋转ISO感光度拨盘，"
        "可根据可用的光量调节照相机对光的敏感度（ISO感光度）。\n\n"
        "![ISO感光度拨盘示意图](assets/knowledge_p28-30_004.png)\n\n"
        "拍摄过程中，当前所选项显示在屏幕中。\n\n"
        "![ISO感光度屏幕显示示例](assets/knowledge_p130-135_002.png)"
    )
    q004["updated_at"] = now_iso()
    q152["enabled"] = False
    q152["updated_at"] = now_iso()
    actions.append("q152 → merged into q004 (ISO拨盘), q152 disabled")

    # --- q084 absorbs q086 (SnapBridge) ---
    q084 = m["q084"]
    q086 = m["q086"]
    q084["variants"] = merge_variants(
        q084.get("variants", []),
        q086.get("variants", []),
        [q086["question"]],
    )
    q084["updated_at"] = now_iso()
    q086["enabled"] = False
    q086["updated_at"] = now_iso()
    actions.append("q086 → merged into q084 (SnapBridge), q086 disabled")

    # --- q089 absorbs q085 (尼康工坊) ---
    q089 = m["q089"]
    q085 = m["q085"]
    q089["variants"] = merge_variants(
        q089.get("variants", []),
        q085.get("variants", []),
        [q085["question"]],
    )
    q089["updated_at"] = now_iso()
    q085["enabled"] = False
    q085["updated_at"] = now_iso()
    actions.append("q085 → merged into q089 (尼康工坊), q085 disabled")

    # --- content fixes (wrong headings / stray page refs) ---
    q155 = m["q155"]
    if q155["answer"].startswith("## 视频模式"):
        q155["answer"] = re.sub(
            r"^## 视频模式\n",
            "# 高ISO感光度\n",
            q155["answer"],
            count=1,
        )
        q155["answer"] = re.sub(r"\nISO感光度拨盘\n\d+\s*$", "", q155["answer"])
        q155["updated_at"] = now_iso()
        actions.append("q155: fixed heading 视频模式 → 高ISO感光度")

    q158 = m["q158"]
    if "通过曝光补偿拨盘之外" in q158["answer"]:
        q158["answer"] = q158["answer"].replace(
            "## 通过曝光补偿拨盘之外的方式进行设定\n---\n✅ 模式M\n---",
            "# 模式M下的曝光补偿",
        )
        q158["updated_at"] = now_iso()
        actions.append("q158: fixed wrong heading (copied from q157)")

    QPATH.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    enabled = sum(1 for it in items if it.get("enabled", True))
    disabled = len(items) - enabled
    print(f"Saved {QPATH}")
    print(f"Total: {len(items)} items, {enabled} enabled, {disabled} disabled\n")
    for a in actions:
        print(f"  - {a}")


if __name__ == "__main__":
    main()
