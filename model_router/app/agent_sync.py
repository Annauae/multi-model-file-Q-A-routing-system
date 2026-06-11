from __future__ import annotations

from pathlib import Path
from typing import Dict, Literal

from .agents_store import AgentsStore
from .knowledge_loader import agent_files_dir, resolve_agent_knowledge

SyncResult = Literal["missing", "reset", "staged", "unchanged"]


def sync_agent_from_files(
    *,
    store: AgentsStore,
    project_root: Path,
    agent_id: str,
    max_chars: int,
) -> SyncResult:
    """Align one agent entry in agents.json with files/agent_{id}/ on disk."""
    cfg = store.get(agent_id)
    if not cfg:
        return "missing"

    files_dir = agent_files_dir(agent_id)
    knowledge_text, _, _ = resolve_agent_knowledge(
        project_root=project_root,
        agent_id=agent_id,
        configured_knowledge="",
        max_chars=max_chars,
        require_file_knowledge=True,
    )

    if not knowledge_text:
        had_data = bool(
            str(cfg.get("knowledge", "") or cfg.get("answer_prompt", "") or "").strip()
            or cfg.get("status") == "initialized"
            or cfg.get("route_questions")
        )
        store.reset_agent_to_created(agent_id=agent_id)
        return "reset" if had_data else "unchanged"

    current = str(cfg.get("knowledge", "") or cfg.get("answer_prompt", "") or "").strip()
    if current == knowledge_text and cfg.get("status") == "initialized":
        return "unchanged"

    store.set_knowledge(agent_id=agent_id, knowledge=knowledge_text)
    store.mark_uninitialized(agent_id=agent_id)
    return "staged"


def sync_all_agents_from_files(
    *,
    store: AgentsStore,
    project_root: Path,
    max_chars: int,
) -> Dict[str, SyncResult]:
    results: Dict[str, SyncResult] = {}
    for agent_id in sorted(store.get_all().keys(), key=lambda x: (len(x), x)):
        results[agent_id] = sync_agent_from_files(
            store=store,
            project_root=project_root,
            agent_id=agent_id,
            max_chars=max_chars,
        )
    return results
