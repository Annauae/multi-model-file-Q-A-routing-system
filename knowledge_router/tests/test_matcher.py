from __future__ import annotations

from knowledge_router.app.matcher import (
    NONE_SENTINEL,
    build_match_system_prompt,
    default_clarification_question,
    parse_match_raw,
)
from knowledge_router.app.schemas import QAItem


def test_build_match_system_prompt_includes_ids() -> None:
    items = [
        QAItem(id="q001", question="曝光补偿怎么用？", answer="a"),
        QAItem(id="q002", question="触控屏怎么用？", answer="b", enabled=False),
    ]
    prompt = build_match_system_prompt(match_prompt="", enabled_items=items)
    assert "q001|曝光补偿怎么用？" in prompt
    assert "q002|" not in prompt


def test_build_match_system_prompt_includes_variants_scheme_a() -> None:
    items = [
        QAItem(
            id="q001",
            question="曝光补偿怎么用？",
            variants=["怎么调照片明暗", "曝光补偿数值什么意思"],
            answer="a",
        ),
    ]
    prompt = build_match_system_prompt(match_prompt="", enabled_items=items)
    assert "q001|曝光补偿怎么用？" in prompt
    assert "q001|怎么调照片明暗" in prompt
    assert "q001|曝光补偿数值什么意思" in prompt


def test_parse_match_raw_id() -> None:
    result = parse_match_raw(raw="q001", valid_ids={"q001", "q002"})
    assert result.matched_id == "q001"
    assert not result.need_clarification


def test_parse_match_raw_none() -> None:
    result = parse_match_raw(raw="none", valid_ids={"q001"})
    assert result.need_clarification
    assert result.clarification_question == default_clarification_question()


def test_parse_match_raw_invalid_id() -> None:
    result = parse_match_raw(raw="q999", valid_ids={"q001"})
    assert result.need_clarification


def test_parse_match_raw_strips_markdown() -> None:
    result = parse_match_raw(raw="`q001`", valid_ids={"q001"})
    assert result.matched_id == "q001"


def test_none_sentinel_constant() -> None:
    assert NONE_SENTINEL == "NONE"
