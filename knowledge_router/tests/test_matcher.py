from __future__ import annotations

from knowledge_router.app.matcher import (
    NONE_SENTINEL,
    build_match_system_prompt,
    default_clarification_question,
    parse_confidence_raw,
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


def test_parse_confidence_raw_array() -> None:
    raw = '[{"id":"q001","confidence":0.92},{"id":"q002","confidence":0.45},{"id":"q999","confidence":0.8}]'
    items, _ = parse_confidence_raw(raw=raw, valid_ids={"q001", "q002"}, top_k=5)
    assert len(items) == 2
    assert items[0]["id"] == "q001"
    assert items[0]["confidence"] == 0.92
    assert items[1]["id"] == "q002"


def test_parse_confidence_raw_dedup_and_sort() -> None:
    raw = '[{"id":"q001","confidence":0.4},{"id":"q001","confidence":0.9}]'
    items, _ = parse_confidence_raw(raw=raw, valid_ids={"q001"}, top_k=5)
    assert len(items) == 1
    assert items[0]["confidence"] == 0.4


def test_parse_confidence_raw_empty() -> None:
    items, _ = parse_confidence_raw(raw="[]", valid_ids={"q001"}, top_k=5)
    assert items == []
