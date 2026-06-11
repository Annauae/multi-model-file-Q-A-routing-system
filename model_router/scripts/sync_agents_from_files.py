"""Sync config/agents.json with files/agent_*/knowledge.md on disk."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_sync import sync_all_agents_from_files
from app.agents_store import AgentsStore
from app.config import Settings


def main() -> None:
    settings = Settings.load()
    store = AgentsStore.open(settings.agents_config_path)
    results = sync_all_agents_from_files(
        store=store,
        project_root=settings.data_root,
        max_chars=settings.max_file_chars,
    )
    for agent_id, status in results.items():
        print(f"[{status}] agent_{agent_id}")
    print(f"done. agents_json={settings.agents_config_path}")


if __name__ == "__main__":
    main()
