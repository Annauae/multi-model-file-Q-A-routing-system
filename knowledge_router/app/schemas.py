"""
schemas.py — Pydantic 数据模型（API 请求/响应 + 内部数据结构）

职责：
  - 定义 questions.json 单条 FAQ（QAItem）、整文件（QuestionsDocument）
  - 定义匹配结果 MatchResult、问答响应 AskResponse、耗时 AskTimings
  - FastAPI 用这些模型做 JSON 校验与 OpenAPI 文档

核心模型关系：
  AskRequest(question, kb_id)
    → MatchResult(matched_id, ...)
    → AskResponse(answer 来自内存 QAItem，非 LLM 生成)

阅读顺序：第 3 个（理解数据结构后再看 store/cache/matcher）
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class Citation(BaseModel):
    """引用来源，仅用于前端展示，不参与匹配。"""

    file: str = ""
    page: Optional[int] = None
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    snippet: str = ""
    asset_file: Optional[str] = None


class QAItem(BaseModel):
    """questions.json 中 items[] 的一条 FAQ。"""

    id: str                    # 唯一 ID，匹配模型返回 matched_id 后 O(1) 查表
    question: str              # 标准问题（匹配主锚点）
    variants: List[str] = Field(default_factory=list)  # 变体问法，一并送入匹配模型
    answer: str                # 预存 Markdown 回答，匹配成功后原样返回
    citations: List[Citation] = Field(default_factory=list)
    enabled: bool = True       # False 时不进入 match_candidates
    updated_at: str = ""       # 保存时由 store 自动写入 ISO 时间


class QuestionsDocument(BaseModel):
    """files/kb_{id}/questions.json 根结构。"""

    version: int = 1
    items: List[QAItem] = Field(default_factory=list)


class MatchCandidate(BaseModel):
    """送入匹配模型的候选条目（不含 answer，减少 token）。"""

    id: str
    question: str
    variants: List[str] = Field(default_factory=list)


class MatchResult(BaseModel):
    """匹配模型输出解析后的结构。"""

    matched_id: str = ""
    matched_question: str = ""       # 命中条目的标准问题（便于前端展示）
    matched_variants: List[str] = Field(default_factory=list)
    need_clarification: bool = False  # True 表示无合适 FAQ，不返回答案
    clarification_question: str = ""


class AskTimings(BaseModel):
    """/ask 各阶段耗时（毫秒）。"""

    total_ms: float = 0.0              # 端到端总耗时
    match_ms: float = 0.0              # 匹配模型调用总耗时
    match_first_token_ms: float = 0.0  # 匹配模型首 token（流式时）
    lookup_ms: float = 0.0             # 内存查表取 answer 的耗时（通常 <1ms）


class AskRequest(BaseModel):
    """POST /ask 与 /ask/stream 的请求体。"""

    question: str = Field(..., min_length=1)
    kb_id: str = Field(..., min_length=1)


class AskResponse(BaseModel):
    """POST /ask 与 SSE done 事件的完整响应。"""

    question: str
    kb_id: str
    match: MatchResult
    answer: str = ""                 # 预存回答；need_clarification 时为空
    citations: List[Citation] = Field(default_factory=list)
    timings: AskTimings = Field(default_factory=AskTimings)
    cache_hit: bool = True           # 候选与答案均来自内存缓存
    enabled_count: int = 0           # 参与匹配的 FAQ 条数
    kb_loaded_at: str = ""           # 该 kb 内存索引载入时间


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class KnowledgeBaseSummary(BaseModel):
    """单个知识库元数据 + 运行时统计（条目数来自 QuestionsCache）。"""

    kb_id: str
    name: str
    status: str = "ready"
    match_prompt: str = ""           # 空则用 matcher.MATCH_SYSTEM_PROMPT_ZH
    item_count: int = 0
    enabled_count: int = 0
    created_at: str = ""
    updated_at: str = ""


class KnowledgeBasesListResponse(BaseModel):
    knowledge_bases: Dict[str, KnowledgeBaseSummary]


class CreateKnowledgeBaseRequest(BaseModel):
    name: str = Field(..., min_length=1)
    kb_id: str = ""                  # 空则自动分配下一个数字 ID


class RenameKnowledgeBaseRequest(BaseModel):
    name: str = Field(..., min_length=1)


class SetMatchPromptRequest(BaseModel):
    match_prompt: str = ""


class QAItemUpsertRequest(BaseModel):
    """管理页单条 FAQ 保存时的请求体。"""

    id: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)
    variants: List[str] = Field(default_factory=list)
    answer: str = Field(..., min_length=1)
    citations: List[Citation] = Field(default_factory=list)
    enabled: bool = True

    @field_validator("variants", mode="before")
    @classmethod
    def _normalize_variants(cls, v):
        if not isinstance(v, list):
            return []
        return [str(x).strip() for x in v if str(x).strip()]


class QuestionsDocumentResponse(BaseModel):
    """GET /knowledge-bases/{id}/questions 的响应（含缓存元信息）。"""

    kb_id: str
    document: QuestionsDocument
    loaded_at: str = ""
    source_mtime: float = 0.0
