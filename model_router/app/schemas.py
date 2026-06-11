from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, description="用户问题")


class RouterTargetAgent(BaseModel):
    agent_id: str
    matched_route_questions: List[str] = Field(default_factory=list)
    reason: str = ""
    rewritten_query: str = ""
    confidence: Literal["high", "low"] = "low"

    @field_validator("confidence", mode="before")
    @classmethod
    def _normalize_confidence(cls, v):
        # Some gateways/models may output "medium". Normalize to required high/low.
        if isinstance(v, str):
            s = v.strip().lower()
            if s == "high":
                return "high"
            if s == "low":
                return "low"
        return "low"


class RouterResult(BaseModel):
    target_agents: List[RouterTargetAgent] = Field(default_factory=list)
    need_clarification: bool = False
    clarification_question: str = ""


class Citation(BaseModel):
    file: str
    page: Optional[int] = None
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    snippet: str = ""
    asset_file: Optional[str] = None


class MergedIllustration(BaseModel):
    file: str
    page: Optional[int] = None
    caption: str = ""


class AskTimings(BaseModel):
    total_ms: float = 0.0
    route_ms: float = 0.0
    route_first_token_ms: float = 0.0
    first_token_ms: float = 0.0  # answer first token (from request start)
    agents_ms: float = 0.0
    merge_ms: float = 0.0


class PerAgentTimings(BaseModel):
    total_ms: float = 0.0
    expand_files_ms: float = 0.0
    load_files_ms: float = 0.0
    llm_answer_ms: float = 0.0
    citations_ms: float = 0.0


class PerAgentAnswer(BaseModel):
    agent_id: str
    agent_name: str
    knowledge_source: str = ""
    used_files: List[str] = Field(default_factory=list)
    context_note: Optional[str] = None
    route: RouterTargetAgent
    answer: str
    citations: List[Citation] = Field(default_factory=list)
    timings: Optional[PerAgentTimings] = None


class AskResponse(BaseModel):
    question: str
    target_agents: List[RouterTargetAgent] = Field(default_factory=list)
    need_clarification: bool
    clarification_question: str
    answers: List[PerAgentAnswer] = Field(default_factory=list)
    merged_answer: str
    merged_illustrations: List[MergedIllustration] = Field(default_factory=list)
    timings: AskTimings = Field(default_factory=AskTimings)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class FileTextPreviewResponse(BaseModel):
    file: str
    text: str
    char_count: int
    truncated: bool = False
    context_note: Optional[str] = None
    file_errors: List[str] = Field(default_factory=list)


class AgentFileEntry(BaseModel):
    agent_id: str
    path: str
    label: str


class AgentFilesListResponse(BaseModel):
    files: List[AgentFileEntry] = Field(default_factory=list)


class FileRawResponse(BaseModel):
    file: str
    text: str
    char_count: int


class AgentContextPreviewResponse(BaseModel):
    agent_id: str
    agent_name: str
    used_files: List[str] = Field(default_factory=list)
    context: str
    char_count: int
    truncated: bool = False
    context_note: Optional[str] = None
    file_errors: List[str] = Field(default_factory=list)


AgentStatus = Literal["created", "initialized"]


class FileSummary(BaseModel):
    file: str
    summary: str


class AgentConfig(BaseModel):
    name: str
    status: AgentStatus = "created"
    knowledge: str = Field(
        default="",
        description="纯知识内容（文档/事实）；回答时由系统模板包裹，不含角色与规则。",
    )
    answer_instructions: str = Field(
        default="",
        description="可选：该 agent 的补充回答要求，会追加到系统模板中。",
    )
    answer_prompt: str = Field(
        default="",
        description="已废弃，请使用 knowledge。保留字段仅作兼容。",
    )
    files_dir: str = Field(default="", description="只读：固定为 files/agent_{id}，与 agent 编号硬绑定")
    files: List[str] = Field(default_factory=list)
    route_questions: List[str] = Field(default_factory=list)
    file_summaries: List[FileSummary] = Field(default_factory=list)
    last_initialized_at: str = ""


class UpdateAgentKnowledgeRequest(BaseModel):
    knowledge: str = Field(..., min_length=1, description="纯知识内容文本")


class UpdateAgentInstructionsRequest(BaseModel):
    answer_instructions: str = Field(default="", description="该 agent 的补充回答要求（可为空）")


class UpdateAgentPromptRequest(BaseModel):
    """Deprecated: use UpdateAgentKnowledgeRequest."""
    answer_prompt: str = Field(..., min_length=1, description="纯知识内容（兼容旧字段名）")


class AgentsResponse(BaseModel):
    agents: Dict[str, Dict[str, Any]]


class CreateAgentRequest(BaseModel):
    agent_id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)


class RegisterFilesRequest(BaseModel):
    files: List[str] = Field(default_factory=list, description="本地文件路径（相对或绝对路径）")


class AgentResponse(BaseModel):
    agent_id: str
    agent: AgentConfig


class InitializeResponse(BaseModel):
    agent_id: str
    status: AgentStatus
    route_questions_count: int
    last_initialized_at: str


class SyncAgentsResponse(BaseModel):
    results: Dict[str, str] = Field(
        default_factory=dict,
        description="per agent: reset | staged | unchanged | missing",
    )


class RenameAgentRequest(BaseModel):
    new_agent_id: str = Field(..., min_length=1)


class AutoCreateAgentResponse(BaseModel):
    agent_id: str
    name: str
    agent: AgentConfig


class FileTreeNode(BaseModel):
    name: str
    path: str
    type: str  # "dir" | "file"
    children: List["FileTreeNode"] = Field(default_factory=list)


class FileTreeResponse(BaseModel):
    root: str
    tree: List[FileTreeNode] = Field(default_factory=list)


class WriteFileRequest(BaseModel):
    file: str = Field(..., min_length=1)
    text: str = ""


class CreateFileRequest(BaseModel):
    file: str = Field(..., min_length=1)


class RenameFileRequest(BaseModel):
    from_path: str = Field(..., alias="from", min_length=1)
    to_path: str = Field(..., alias="to", min_length=1)

    model_config = {"populate_by_name": True}


class FileWriteResponse(BaseModel):
    file: str
    char_count: int


BatchTestStatus = Literal["pending", "running", "done", "error"]


class BatchTestItem(BaseModel):
    id: str
    question: str
    reference_answer: str
    model_answer: str = ""
    accuracy_percent: Optional[int] = None
    accuracy_reason: str = ""
    status: BatchTestStatus = "pending"
    last_agent_id: str = ""
    knowledge_source: str = ""
    last_error: str = ""
    created_at: str = ""
    updated_at: str = ""


class BatchTestsListResponse(BaseModel):
    items: List[BatchTestItem] = Field(default_factory=list)


class BatchTestResponse(BaseModel):
    item: BatchTestItem


class CreateBatchTestRequest(BaseModel):
    question: str = Field(..., min_length=1)
    reference_answer: str = Field(..., min_length=1)


class UpdateBatchTestRequest(BaseModel):
    question: Optional[str] = Field(default=None, min_length=1)
    reference_answer: Optional[str] = Field(default=None, min_length=1)


class ImportBatchTestsRequest(BaseModel):
    text: str = Field(..., min_length=1)
    format: Literal["json", "md", "auto"] = "auto"


class ImportBatchTestsResponse(BaseModel):
    imported: int
    items: List[BatchTestItem] = Field(default_factory=list)


class BatchTestRunResponse(BaseModel):
    item: BatchTestItem
    route_ms: float = 0.0
    agents_ms: float = 0.0
    total_ms: float = 0.0
    need_clarification: bool = False
    clarification_question: str = ""
