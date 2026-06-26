"""API 请求/响应与领域模型的 Pydantic 定义。

所有 HTTP 接口的入参、出参类型集中在此，便于 FastAPI 自动校验与 OpenAPI 文档生成。
"""
from __future__ import annotations

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class QAItem(BaseModel):

    id: str  # 唯一标识，如 q001
    question: str  # 标准问题文本
    variants: List[str] = Field(default_factory=list)  # 变体问法，用于扩充匹配 prompt
    answer: str  # Markdown 格式预存回答
    enabled: bool = True  # False 时不进入匹配 prompt
    updated_at: str = ""  # ISO8601 更新时间


class QuestionsDocument(BaseModel):
    """questions.json 顶层结构。"""

    version: int = 1
    items: List[QAItem] = Field(default_factory=list)


class AskRequest(BaseModel):
    """POST /ask、/ask/stream 请求体。"""

    question: str = Field(..., min_length=1)  # 用户自然语言问题
    kb_id: str = Field(..., min_length=1)  # 目标知识库 id


class MatchResult(BaseModel):
    """单 id 匹配结果（精确匹配模式）。"""

    matched_id: str = ""  # 命中的标准问题 id
    matched_question: str = ""  # 对应标准问题文本（查表填充）
    raw_output: str = ""  # 模型原始输出
    need_clarification: bool = False  # True 表示未匹配，需澄清
    clarification_question: str = ""  # 返回给用户的澄清话术


class TokenUsage(BaseModel):
    """LLM token 用量。"""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class PhaseTokens(BaseModel):
    """单阶段 token 细分。"""

    phase: str
    usage: TokenUsage = Field(default_factory=TokenUsage)


class AskTimings(BaseModel):
    """问答链路各阶段耗时（毫秒），用于前端展示与日志。"""

    total_ms: float = 0.0
    prepare_ms: float = 0.0  # 索引加载 + 拼 prompt
    match_ms: float = 0.0  # LLM 匹配调用
    match_first_token_ms: float = 0.0  # 流式首 token 延迟
    lookup_ms: float = 0.0  # 内存查表取 answer
    match_output_tokens: int = 0  # 兼容旧字段；优先用 tokens.completion_tokens
    tokens: TokenUsage = Field(default_factory=TokenUsage)
    token_breakdown: List[PhaseTokens] = Field(default_factory=list)


class AskResponse(BaseModel):
    """POST /ask 完整响应。"""

    question: str
    kb_id: str
    match: MatchResult
    answer: str = ""  # 预存回答；未匹配时为空
    timings: AskTimings = Field(default_factory=AskTimings)
    cache_hit: bool = True  # 回答来自内存缓存而非生成模型


class ConfidenceCandidate(BaseModel):
    """置信度匹配模式下的单个候选。"""

    id: str
    confidence: float  # 0~1，模型给出的匹配置信度
    question: str = ""  # 标准问题文本（服务端查表填充）


class ConfidenceMatchResult(BaseModel):
    """置信度匹配结果（可多候选）。"""

    raw_output: str = ""  # 模型原始 JSON 输出
    candidates: List[ConfidenceCandidate] = Field(default_factory=list)


class CandidateAnswer(BaseModel):
    """置信度匹配下单个候选的完整回答。"""

    id: str
    confidence: float
    question: str = ""
    answer: str = ""


class ConfidenceAskResponse(BaseModel):
    """POST /ask/confidence 完整响应。"""

    question: str
    kb_id: str
    match: ConfidenceMatchResult
    answer: str = ""  # 默认取 Top1 候选的预存回答
    answers: List[CandidateAnswer] = Field(default_factory=list)
    timings: AskTimings = Field(default_factory=AskTimings)
    cache_hit: bool = True


class ConfidenceAskRequest(BaseModel):
    """POST /ask/confidence、/ask/confidence/stream 请求体。"""

    question: str = Field(..., min_length=1)
    kb_id: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)
    match_profile_id: str = ""  # 空则用默认 profile


class HealthResponse(BaseModel):
    """GET /health 探活响应。"""

    status: str = "ok"


class KnowledgeBaseCreateRequest(BaseModel):
    """POST /knowledge-bases 创建知识库。"""

    name: str = Field(..., min_length=1)  # 显示名称
    kb_id: str = ""  # 可省略，由服务端自动分配数字 id


class KnowledgeBaseRenameRequest(BaseModel):
    """POST /knowledge-bases/{kb_id}/rename。"""

    name: str = Field(..., min_length=1)


class MatchPromptUpdateRequest(BaseModel):
    """PUT /knowledge-bases/{kb_id}/prompt 更新匹配规则（不含问题列表）。"""

    match_prompt: str = ""
    confidence_match_prompt: str | None = None


class ConfidencePromptPreviewResponse(BaseModel):
    """置信度 system prompt 预览。"""

    kb_id: str
    confidence_match_prompt: str
    system_prompt: str
    enabled_count: int


class RecallTestRow(BaseModel):
    """召回度测试单行。"""

    id: str
    question: str
    run_at: str = ""
    candidates: List[ConfidenceCandidate] = Field(default_factory=list)
    answers: List[CandidateAnswer] = Field(default_factory=list)
    recalled: str | None = None  # yes | no | null
    notes: str = ""
    match_profile_id: str = ""
    model_label: str = ""
    timings: AskTimings | None = None


class RecallTestDocument(BaseModel):
    items: List[RecallTestRow] = Field(default_factory=list)


class ModelsConfigUpdateRequest(BaseModel):
    match: Dict[str, Any] | None = None
    import_: Dict[str, Any] | None = Field(default=None, alias="import")
    pdf_vlm: Dict[str, Any] | None = None

    model_config = {"populate_by_name": True}


class QAItemUpsertRequest(BaseModel):
    """单条 FAQ 新增/更新请求体。"""

    id: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)
    variants: List[str] = Field(default_factory=list)
    answer: str = Field(..., min_length=1)
    enabled: bool = True


class QuestionsReplaceRequest(BaseModel):
    """PUT /knowledge-bases/{kb_id}/questions 整库替换。"""

    version: int = 1
    items: List[QAItemUpsertRequest] = Field(default_factory=list)


class MatchPromptPreviewResponse(BaseModel):
    """GET match-prompt-preview：规则 + 完整 system prompt 预览。"""

    kb_id: str
    match_prompt: str  # 仅规则部分
    system_prompt: str  # 规则 + 【标准问题列表】
    enabled_count: int  # 启用条目数


class DefaultPromptResponse(BaseModel):
    """GET /knowledge-bases/default-prompt 默认匹配规则。"""

    match_prompt: str
