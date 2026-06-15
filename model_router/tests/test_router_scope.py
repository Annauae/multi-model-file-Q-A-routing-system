"""Tests for router-scoped agent filtering."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.router import get_eligible_agents, _router_system_prompt, ROUTER_SYSTEM_PROMPT_ZH


def test_get_eligible_agents_filters_by_router_id() -> None:
    agents = {
        "1": {"router_id": "1", "status": "initialized", "route_questions": ["q1"]},
        "2": {"router_id": "2", "status": "initialized", "route_questions": ["q2"]},
        "3": {"router_id": "1", "status": "created", "route_questions": ["q3"]},
    }
    r1 = get_eligible_agents(agents, router_id="1")
    assert set(r1.keys()) == {"1"}
    r2 = get_eligible_agents(agents, router_id="2")
    assert set(r2.keys()) == {"2"}


def test_router_system_prompt_fallback() -> None:
    assert _router_system_prompt("") == ROUTER_SYSTEM_PROMPT_ZH
    assert _router_system_prompt("custom") == "custom"
