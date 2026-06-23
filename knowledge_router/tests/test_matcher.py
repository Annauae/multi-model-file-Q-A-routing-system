from __future__ import annotations

import json

import pytest

from app.matcher import build_match_messages, parse_match_raw
from app.schemas import MatchCandidate


def test_parse_match_raw_valid_id() -> None:
    candidates = [
        MatchCandidate(id="q001", question="A?", variants=["a"]),
        MatchCandidate(id="q002", question="B?", variants=[]),
    ]
    raw = json.dumps({"matched_id": "q002", "need_clarification": False, "clarification_question": ""})
    result = parse_match_raw(raw=raw, candidates=candidates)
    assert result.matched_id == "q002"
    assert result.matched_question == "B?"
    assert result.need_clarification is False


def test_parse_match_raw_invalid_id_needs_clarification() -> None:
    candidates = [MatchCandidate(id="q001", question="A?", variants=[])]
    raw = json.dumps({"matched_id": "missing", "need_clarification": False})
    result = parse_match_raw(raw=raw, candidates=candidates)
    assert result.need_clarification is True
    assert result.matched_id == ""


def test_build_match_messages_includes_candidates() -> None:
    candidates = [MatchCandidate(id="q001", question="Q?", variants=["v1"])]
    messages = build_match_messages(question="用户问", candidates=candidates, match_prompt="")
    assert len(messages) == 2
    payload = json.loads(messages[1].content)
    assert payload["question"] == "用户问"
    assert payload["candidates"][0]["id"] == "q001"
