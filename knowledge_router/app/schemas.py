from __future__ import annotations

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class QAItem(BaseModel):
    id: str
    question: str
    variants: List[str] = Field(default_factory=list)
    answer: str
    enabled: bool = True
    updated_at: str = ""


class QuestionsDocument(BaseModel):
    version: int = 1
    items: List[QAItem] = Field(default_factory=list)


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1)
    kb_id: str = Field(..., min_length=1)


class MatchResult(BaseModel):
    matched_id: str = ""
    matched_question: str = ""
    raw_output: str = ""
    need_clarification: bool = False
    clarification_question: str = ""


class AskTimings(BaseModel):
    total_ms: float = 0.0
    prepare_ms: float = 0.0
    match_ms: float = 0.0
    match_first_token_ms: float = 0.0
    lookup_ms: float = 0.0
    match_output_tokens: int = 0


class AskResponse(BaseModel):
    question: str
    kb_id: str
    match: MatchResult
    answer: str = ""
    timings: AskTimings = Field(default_factory=AskTimings)
    cache_hit: bool = True


class ConfidenceCandidate(BaseModel):
    id: str
    confidence: float
    question: str = ""


class ConfidenceMatchResult(BaseModel):
    raw_output: str = ""
    candidates: List[ConfidenceCandidate] = Field(default_factory=list)


class ConfidenceAskResponse(BaseModel):
    question: str
    kb_id: str
    match: ConfidenceMatchResult
    answer: str = ""
    timings: AskTimings = Field(default_factory=AskTimings)
    cache_hit: bool = True


class ConfidenceAskRequest(BaseModel):
    question: str = Field(..., min_length=1)
    kb_id: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


class HealthResponse(BaseModel):
    status: str = "ok"


class KnowledgeBaseCreateRequest(BaseModel):
    name: str = Field(..., min_length=1)
    kb_id: str = ""


class KnowledgeBaseRenameRequest(BaseModel):
    name: str = Field(..., min_length=1)


class MatchPromptUpdateRequest(BaseModel):
    match_prompt: str = ""


class QAItemUpsertRequest(BaseModel):
    id: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)
    variants: List[str] = Field(default_factory=list)
    answer: str = Field(..., min_length=1)
    enabled: bool = True


class QuestionsReplaceRequest(BaseModel):
    version: int = 1
    items: List[QAItemUpsertRequest] = Field(default_factory=list)


class MatchPromptPreviewResponse(BaseModel):
    kb_id: str
    match_prompt: str
    system_prompt: str
    enabled_count: int


class DefaultPromptResponse(BaseModel):
    match_prompt: str
