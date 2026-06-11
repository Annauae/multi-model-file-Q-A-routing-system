from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agents_store import AgentsStore
from app.config import Settings
from app.initializer import generate_route_questions_and_summaries
from app.llm_client import LLMClient
from app.knowledge_loader import resolve_agent_knowledge


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh initialization for selected agents.")
    parser.add_argument("agent_ids", nargs="+", help="agent id list, e.g. 1 2 3")
    args = parser.parse_args()

    settings = Settings.load()
    store = AgentsStore.open(settings.agents_config_path)
    llm = LLMClient(settings)

    for agent_id in args.agent_ids:
        cfg = store.get(agent_id)
        if not cfg:
            print(f"[skip] agent {agent_id} not found")
            continue

        name = str(cfg.get("name", agent_id))
        files_dir = str(cfg.get("files_dir", "") or "").strip()
        configured_knowledge = str(cfg.get("knowledge", "") or cfg.get("answer_prompt", "") or "")

        knowledge_text, knowledge_source, _ = resolve_agent_knowledge(
            project_root=settings.data_root,
            agent_id=agent_id,
            files_dir=files_dir,
            configured_knowledge=configured_knowledge,
            max_chars=settings.max_file_chars,
            require_file_knowledge=True,
        )
        if not knowledge_text:
            store.reset_agent_to_created(agent_id=agent_id)
            print(f"[reset] agent {agent_id} knowledge empty; cleared agents.json cache")
            continue

        store.set_knowledge(agent_id=agent_id, knowledge=knowledge_text)
        print(f"[init] agent_id={agent_id} source={knowledge_source} chars={len(knowledge_text)}", flush=True)
        route_questions, file_summaries = generate_route_questions_and_summaries(
            agent_id=agent_id,
            agent_name=name,
            knowledge=knowledge_text,
            knowledge_source=knowledge_source,
            llm=llm,
            init_model=settings.init_model,
            min_route_questions=settings.min_route_questions,
            max_route_questions=settings.max_route_questions,
        )
        store.update_initialized(
            agent_id=agent_id,
            files=[knowledge_source],
            route_questions=route_questions,
            file_summaries=file_summaries,
        )
        summary_preview = file_summaries[0]["summary"][:80] if file_summaries else ""
        print(
            f"[ok] agent_id={agent_id} questions={len(route_questions)} summary={summary_preview}...",
            flush=True,
        )

    print("done.", flush=True)


if __name__ == "__main__":
    main()
