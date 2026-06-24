#!/usr/bin/env python3
"""用途：从 model_router 批量导入 FAQ。

读取 agent Markdown，调用 LLM 生成标准问题/变体/回答，写入 questions.json（正式导入流水线）。
离线维护工具，不参与 Web 服务运行。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT.parent) not in sys.path:
    sys.path.insert(0, str(ROOT.parent))

from knowledge_router.app.config import Settings
from knowledge_router.app.llm_client import LLMClient
from knowledge_router.app.questions_import import assign_question_ids, import_router_agents


def _parse_agent_range(spec: str) -> list[int]:
    spec = (spec or "").strip()
    if not spec:
        return list(range(1, 6))
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return sorted(set(out))


def main() -> None:
    parser = argparse.ArgumentParser(description="从 model_router agent md 批量生成 questions.json")
    parser.add_argument(
        "--router-dir",
        default=str(ROOT.parent / "model_router" / "files" / "router_1"),
        help="router 目录，如 model_router/files/router_1",
    )
    parser.add_argument("--agents", default="1-5", help="agent 编号，如 1-5 或 1,3,7")
    parser.add_argument("--kb-id", default="1", help="目标知识库 id")
    parser.add_argument(
        "--output",
        default="",
        help="输出 questions.json 路径，默认 files/kb_{kb_id}/questions.json",
    )
    parser.add_argument("--append", action="store_true", help="追加到已有 questions.json 而非覆盖")
    args = parser.parse_args()

    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=True)
    settings = Settings.load()
    llm = LLMClient(settings)
    router_dir = Path(args.router_dir).resolve()
    kb_id = args.kb_id.strip()
    kb_assets = settings.files_root / f"kb_{kb_id}" / "assets"
    out_path = Path(args.output).resolve() if args.output else settings.files_root / f"kb_{kb_id}" / "questions.json"

    agent_nums = _parse_agent_range(args.agents)

    def progress(msg: str) -> None:
        print(msg, flush=True)

    progress(f"导入 router={router_dir.name} agents={agent_nums} -> kb_{kb_id}")
    progress(f"模型: {settings.import_model}")

    raw_items = import_router_agents(
        router_dir=router_dir,
        kb_assets_dir=kb_assets,
        agent_nums=agent_nums,
        llm=llm,
        import_model=settings.import_model,
        on_progress=progress,
    )

    start_id = 1
    existing_items: list[dict] = []
    if args.append and out_path.exists():
        doc = json.loads(out_path.read_text(encoding="utf-8"))
        existing_items = doc.get("items", [])
        ids = [int(str(x.get("id", "q0")).lstrip("q") or 0) for x in existing_items if isinstance(x, dict)]
        start_id = max(ids, default=0) + 1

    new_items = assign_question_ids(raw_items, start=start_id)
    doc = {"version": 1, "items": existing_items + new_items if args.append else new_items}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    progress(f"完成：写入 {len(new_items)} 条 -> {out_path}（合计 {len(doc['items'])} 条）")
    progress("若服务已运行，请 reload 知识库或重启服务。")


if __name__ == "__main__":
    main()
