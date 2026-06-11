"""Split files/u001_whole.md into files/agent_*/knowledge.md (plain markdown)."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agents_store import AgentsStore
from app.agent_sync import sync_all_agents_from_files
from app.config import Settings
from app.faq_converter import normalize_image_paths, split_whole_md_by_agent


def main() -> None:
    parser = argparse.ArgumentParser(description="Split u001_whole.md into agent knowledge.md files")
    parser.add_argument("--agents", type=int, default=13, help="Number of agents to split into (default: 13)")
    args = parser.parse_args()
    n_agents = max(1, args.agents)
    files_root = Path(__file__).resolve().parents[1] / "files"
    whole_path = files_root / "u001_whole.md"
    whole_text = whole_path.read_text(encoding="utf-8")

    source_file = "ZfcRGPRC_(Sc)12_入门两章.pdf"
    m = re.match(r"---\n(.*?)\n---", whole_text, re.DOTALL)
    if m:
        for line in m.group(1).splitlines():
            if line.startswith("source_file:"):
                source_file = line.split(":", 1)[1].strip()

    chunks = split_whole_md_by_agent(whole_text, n_agents=n_agents)
    for agent_id, p_start, p_end, chunk in chunks:
        body = normalize_image_paths(chunk)
        content = (
            "---\n"
            f"source_file: {source_file}\n"
            f"agent_id: {agent_id}\n"
            f"page_start: {p_start}\n"
            f"page_end: {p_end}\n"
            "---\n\n"
            f"{body}\n"
        )
        out_dir = files_root / f"agent_{agent_id}"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "knowledge.md"
        out_path.write_text(content, encoding="utf-8")
        print(f"[ok] agent_{agent_id}: pages {p_start}-{p_end} -> {out_path}")

    settings = Settings.load()
    store = AgentsStore.open(settings.agents_config_path)
    sync_results = sync_all_agents_from_files(
        store=store,
        project_root=settings.data_root,
        max_chars=settings.max_file_chars,
    )
    for aid, status in sync_results.items():
        if status != "unchanged":
            print(f"[sync] agent_{aid}: {status}")


if __name__ == "__main__":
    main()
