from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings
from app.faq_converter import write_agent_faq_files
from app.llm_client import LLMClient


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read files/u001_whole.md and write FAQ to files/agent_*/knowledge.md only (never modifies the source)."
    )
    parser.add_argument(
        "--source",
        default="files/u001_whole.md",
        help="Path to whole markdown (relative to DATA_ROOT or absolute); read-only",
    )
    parser.add_argument(
        "--agents",
        nargs="*",
        help="Agent ids to convert (default: all 13)",
    )
    parser.add_argument(
        "--min-faqs",
        type=int,
        default=30,
        help="Minimum FAQ entries per agent (default: 30)",
    )
    parser.add_argument(
        "--llm",
        action="store_true",
        help="Use LLM for FAQ rewrite (default: offline heuristic, fast and no API)",
    )

    args = parser.parse_args()

    settings = Settings.load()
    llm = LLMClient(settings) if args.llm else None

    source = Path(args.source)
    if not source.is_absolute():
        source = (settings.data_root / source).resolve()

    agent_ids = [int(x) for x in args.agents] if args.agents else None
    written = write_agent_faq_files(
        whole_md_path=source,
        files_root=settings.files_root,
        llm=llm,
        model=settings.answer_model,
        agent_ids=agent_ids,
        use_llm=args.llm,
        min_faqs=max(1, args.min_faqs),
    )
    for p in written:
        print(f"[ok] {p}")
    print(f"done. converted={len(written)} source_unchanged={source}")


if __name__ == "__main__":
    main()
