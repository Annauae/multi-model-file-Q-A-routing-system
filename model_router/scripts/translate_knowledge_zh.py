#!/usr/bin/env python3
"""Translate a knowledge.md file to Simplified Chinese in chunks via LLM."""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings
from app.llm_client import ChatMessage, LLMClient, LLMError

SYSTEM_PROMPT = """你是专业 Markdown 翻译。将输入的 Markdown 片段翻译成简体中文。

规则：
1. 保留所有 URL、Markdown 链接语法、锚点 id、图片路径不变
2. 软件/项目名称（如 Matomo、Plausible、ArchiveBox）保持英文原名
3. 许可证标识（MIT、GPL-3.0、Apache-2.0 等）和技术栈标签（Docker/Go/Python 等）保持原样
4. 保留 Markdown 结构：标题层级、列表、表格、代码块、空行
5. 只翻译英文描述性文字；已是中文的内容原样保留
6. 这是长文档的一个连续片段，不要添加「以下是翻译」等前言，不要省略任何行
7. 直接输出翻译后的 Markdown，不要用代码块包裹整个输出"""


def split_chunks(text: str, *, max_lines: int) -> list[str]:
    lines = text.splitlines(keepends=True)
    if not lines:
        return []
    chunks: list[str] = []
    buf: list[str] = []
    for line in lines:
        buf.append(line)
        if len(buf) >= max_lines and line.strip() == "":
            chunks.append("".join(buf))
            buf = []
    if buf:
        chunks.append("".join(buf))
    if len(chunks) <= 1 and len(lines) > max_lines:
        chunks = []
        for i in range(0, len(lines), max_lines):
            chunks.append("".join(lines[i : i + max_lines]))
    return chunks


def translate_chunk(llm: LLMClient, model: str, chunk: str, index: int, total: int) -> str:
    user = f"片段 {index + 1}/{total}：\n\n{chunk}"
    out = llm.chat(
        model=model,
        messages=[
            ChatMessage(role="system", content=SYSTEM_PROMPT),
            ChatMessage(role="user", content=user),
        ],
        max_tokens=16384,
    )
    return out.strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Translate knowledge.md to Chinese")
    parser.add_argument(
        "path",
        nargs="?",
        default=str(ROOT / "files" / "agent_2" / "knowledge.md"),
        help="Path to knowledge.md",
    )
    parser.add_argument("--lines", type=int, default=120, help="Lines per chunk")
    parser.add_argument("--dry-run", action="store_true", help="Only print chunk count")
    args = parser.parse_args()

    src = Path(args.path).resolve()
    if not src.is_file():
        print(f"File not found: {src}", file=sys.stderr)
        return 1

    text = src.read_text(encoding="utf-8")
    chunks = split_chunks(text, max_lines=args.lines)
    print(f"Source: {src} ({len(text.splitlines())} lines, {len(chunks)} chunks)")

    if args.dry_run:
        return 0

    backup = src.with_suffix(src.suffix + ".en.bak")
    if not backup.exists():
        shutil.copy2(src, backup)
        print(f"Backup: {backup}")

    settings = Settings.load()
    if settings.mock_llm:
        print("MOCK_LLM=1，无法翻译。请配置 API_KEY 并设置 MOCK_LLM=0。", file=sys.stderr)
        return 1

    llm = LLMClient(settings)
    model = settings.answer_model
    translated: list[str] = []

    for i, chunk in enumerate(chunks):
        t0 = time.perf_counter()
        print(f"Translating chunk {i + 1}/{len(chunks)} …", flush=True)
        try:
            part = translate_chunk(llm, model, chunk, i, len(chunks))
        except LLMError as e:
            print(f"Failed at chunk {i + 1}: {e}", file=sys.stderr)
            return 1
        translated.append(part)
        elapsed = time.perf_counter() - t0
        print(f"  done in {elapsed:.1f}s ({len(part.splitlines())} lines)", flush=True)

    out_text = "\n".join(p.rstrip() for p in translated).strip() + "\n"
    src.write_text(out_text, encoding="utf-8")
    print(f"Written: {src} ({len(out_text.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
