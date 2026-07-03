/**
 * types.ts — 前端共享类型定义
 *
 * 本文件集中声明 Router 控制台各模块共用的 TypeScript 类型，与后端 API 响应体、
 * 本地 JSON 存储结构（questions.json、recall_tests.json 等）及 UI 状态一一对应。
 *
 * 类型分区：
 * - 导航与路由：ModuleName / DebugSub / ManageSub
 * - LLM 匹配问答：KnowledgeBase、QAItem、ConfidenceCandidate、MatchProfile …
 * - 文档与导入：FileTreeNode、ImportSelection
 * - RAG 检索问答：RagSearchResult、RagChatResponse、RagRuntimeConfig …
 * - 通用：TokenUsage、LogEntry、SseEvent
 */


// 导航与路由

/** 侧边栏一级模块，对应 App.tsx 中的 module 状态 */
export type ModuleName = "debug" | "manage" | "logs" | "settings";

/** 调试模块二级子页：单条问答调试 / 召回度批量测试 */
export type DebugSub = "single" | "recall";

/** 管理模块二级子页：FAQ 问题管理 / 源文档文件管理 */
export type ManageSub = "items" | "files";

// 知识库与 FAQ（LLM 匹配模式）

/**
 * 知识库元数据。
 * 配置持久化于 config/knowledge_bases.json 或 config/rag_knowledge_bases.json
 */
export interface KnowledgeBase {
  /** 知识库唯一 id，如 "1"；对应 files/kb_{id} 或 files/rag_kb_{id} */
  kb_id: string;
  /** 界面显示名 */
  name: string;
  /** 库状态，如 "ready"（仅 LLM 库常见） */
  status?: string;
  /** 库级匹配备注（可选） */
  match_prompt?: string;
  /** 当前已启用（enabled=true）的 FAQ 条数，由服务端缓存统计 */
  enabled_count?: number;
}

/**
 * 单条 FAQ 问答项。
 * 持久化于 files/kb_{id}/questions.json 或 files/rag_kb_{id}/questions.json
 */
export interface QAItem {
  /** 条目 id，格式通常为 q001、q002 … */
  id: string;
  /** 标准问法（主问题） */
  question: string;
  /** 其他问法，匹配时与 question 同等参与 prompt 构建 */
  variants: string[];
  /** 答案正文，支持 Markdown；可含相对路径图片引用 */
  answer: string;
  /** 是否参与匹配/索引；false 时 LLM 列表与 RAG 建索引均会跳过 */
  enabled: boolean;
  /** ISO 时间戳，最近更新时间 */
  updated_at?: string;
}

/**
 * FAQ 文档根结构。
 * 对应 PUT/GET …/questions 的请求体与响应体
 */
export interface QuestionsDocument {
  /** 文档版本号，乐观锁用；全量替换时需与当前版本一致 */
  version: number;
  /** 所有 FAQ */
  items: QAItem[];
}

/**
 * LLM 置信度匹配返回的单个候选。
 * 来源：POST /ask/confidence/stream 的 candidates 事件
 */
export interface ConfidenceCandidate {
  /** 命中的 FAQ id */
  id: string;
  /** 模型给出的置信度，0–1；解析失败时可能为 0 */
  confidence: number;
  /** 展示用：该 id 对应的标准问题文本 */
  question?: string;
}

/** 候选 + 完整答案，用于调试页「候选回答」面板展示 */
export interface CandidateAnswer extends ConfidenceCandidate {
  answer: string;
}


// Token 与耗时指标（LLM / RAG 共用）

/** OpenAI 兼容 API 返回的 token 用量统计 */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * LLM 匹配问答各阶段耗时（毫秒）。
 * 来源：POST /ask/confidence 响应的 timings 字段
 */
export interface AskTimings {
  /** 端到端总耗时 */
  total_ms?: number;
  /** 加载索引 + 拼装 system prompt */
  prepare_ms?: number;
  /** LLM 流式匹配调用（含首 token 等待） */
  match_ms?: number;
  /** 匹配阶段首个 token 到达时间（相对 match 开始） */
  match_first_token_ms?: number;
  /** 根据匹配 id 查表取 answer 的耗时 */
  lookup_ms?: number;
  /** 文档 HTML 经 VLM 精修时的耗时（文件导入流程，非问答主路径） */
  vlm_refine_ms?: number;
  /** 匹配阶段汇总 token */
  tokens?: TokenUsage;
  /** 分阶段 token 明细，如 [{ phase: "match", usage: … }] */
  token_breakdown?: { phase: string; usage: TokenUsage }[];
}

/**
 * 问答模型配置 profile。
 * 来源：GET /settings/match-profiles；持久化于 config/match_profiles.json
 * 调试页「问答模型」下拉框每一项对应一个 profile
 */
export interface MatchProfile {
  id: string;
  name: string;
  model: string;
  api_base_url: string;
  api_key: string;
  /** true=强制开启思考链；false=关闭；null=跟随全局 DISABLE_THINKING */
  enable_thinking?: boolean | null;
  max_tokens?: number;
  temperature?: number;
}

// 召回度测试

/**
 * 召回度测试表格中的一行。
 * 持久化于 files/kb_{id}/recall_tests.json 或 rag_kb 下同名文件
 * recalled 为空表示尚未跑批；yes/no 为人工或自动标注结果
 */
export interface RecallTestRow {
  /** 行 id，前端生成或导入时分配 */
  id: string;
  /** 测试用问题文本 */
  question: string;
  /** 是否召回成功：""=未测，"yes"|"no"=已标注 */
  recalled: "yes" | "no" | "";
  /** 最近一次批量运行时间 */
  run_at?: string;
  /** 最近一次 Top-1 命中的 FAQ id */
  last_top_id?: string;
  /** 最近一次 Top-1 置信度（LLM）或 rerank 分（RAG） */
  last_confidence?: number;
  notes?: string;
  /** LLM 模式下使用的 match_profile_id */
  match_profile_id?: string;
  /** 展示用模型标签 */
  model_label?: string;
}

// 文档文件树与 FAQ 导入

/**
 * 文档目录树节点。
 * 来源：GET /markdown-files/tree
 * 根为 files/documents/，子目录含 sources/（源文件）、modules/（提取后的 Markdown）
 */
export interface FileTreeNode {
  type?: "folder" | "file";
  name: string;
  /** 相对 documents/ 的路径，如 sources/foo.pdf、modules/bar.md */
  path?: string;
  /** 服务端 documentTypes 定义的 kind，如 source_pdf、module_md */
  kind?: string;
  /** 文件扩展名归类，如 pdf、md、docx */
  format?: string;
  /** 文本类源文件行数，用于范围选择导入 */
  line_count?: number;
  children?: FileTreeNode[];
  /**
   * 该类型文件支持的操作能力，驱动文件管理 UI 按钮显隐：
   * - editable: 可直接编辑保存
   * - can_convert: 可发起提取/转换
   * - direct_question_gen: 无需提取即可生成 FAQ
   * - default_vlm_refine: 提取时默认勾选 VLM 精修
   */
  capabilities?: {
    editable?: boolean;
    preview_only?: boolean;
    can_convert?: boolean;
    direct_question_gen?: boolean;
    default_vlm_refine?: boolean;
  };
}

/**
 * 从文档选中一段内容后、待提交为 FAQ 的中间态。
 * 用于 ManageFilesView 导入向导：先选行范围 → LLM 生成问法 → 用户确认后 commit
 */
export interface ImportSelection {
  /** 前端临时 id */
  id: string;
  lineStart: number;
  lineEnd: number;
  question: string;
  variants: string[];
  answer: string;
}

// 操作日志与 SSE

/**
 * 操作日志条目。
 * 来源：GET /logs、GET /logs/stream（SSE）
 * 持久化于 logs/operations.jsonl
 */
export interface LogEntry {
  /** ISO 时间戳，SSE 游标 since 参数以此字段递增拉取 */
  ts: string;
  /** 模块：debug、manage、rag、files、settings … */
  module: string;
  action: string;
  kb_id?: string;
  detail?: string;
}

/**
 * Server-Sent Events 解析后的单条事件。
 * 用于 /ask/confidence/stream、/documents/extract/stream 等流式接口
 * event 常见值：log、candidates、done、error
 */
export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

// 问答模式切换

/**
 * 调试/管理页的问答后端模式：
 * - llm：LLM 从 FAQ 列表语义匹配 id（confidence match）
 * - rag：向量+关键词检索，可选 rerank 与 LLM 合成回答
 */
export type AskMode = "llm" | "rag";

// RAG 检索与问答

/**
 * RAG 检索单条命中结果。
 * 来源：POST /rag/search、RagChatResponse.sources
 */
export interface RagSearchResult {
  /** FAQ 条目 id */
  id: string;
  question: string;
  answer: string;
  /** 截断后的答案摘要，用于列表展示 */
  answer_summary?: string;
  /** 向量检索原始分 */
  vector_score?: number;
  /** 关键词（n-gram）检索分 */
  keyword_score?: number;
  /** RRF 融合分（向量与关键词合并后） */
  rrf_score?: number;
  /** Rerank 模型重排后的分；未开 rerank 时可能缺失 */
  rerank_score?: number;
  /** 命中的检索文档类型，如 question、variant、answer_chunk */
  matched_doc_types?: string[];
  /** 答案内引用的图片，url 为可访问的预览地址 */
  images?: { src: string; url: string; alt?: string }[];
}

/**
 * RAG 检索流水线各阶段耗时（毫秒）。
 * 来源：POST /rag/search、/rag/chat 的 timing 字段
 */
export interface RagTimings {
  embedding_ms?: number;
  vector_lookup_ms?: number;
  keyword_search_ms?: number;
  fusion_ms?: number;
  rerank_ms?: number;
  /** LLM 合成回答阶段；仅 chat 且 answer_mode=generated 时有意义 */
  generate_ms?: number;
  /** search 子流程合计（部分响应用作 search_ms 别名） */
  search_ms?: number;
  total_ms?: number;
}

/**
 * RAG 完整问答响应。
 * 来源：POST /rag/chat
 */
export interface RagChatResponse {
  query: string;
  /** 最终展示给用户的回答（直接引用或 LLM 生成） */
  answer: string;
  /** 综合置信度，用于 UI 百分比展示 */
  confidence: number;
  /** 回答策略，如 direct（直出 Top1 答案）或 generated（LLM 合成） */
  mode: string;
  /** 检索来源列表，与 RagSearchResult 结构相同 */
  sources: RagSearchResult[];
  images?: { src: string; url: string; alt?: string }[];
  timing?: RagTimings;
  tokens?: TokenUsage;
  /** 分阶段：embedding、rerank、generate 等 */
  token_breakdown?: { phase: string; usage: TokenUsage }[];
}

/**
 * RAG 模型槽位配置（单 slot）。
 * 来源：GET /settings/rag-models；持久化于 config/rag_models.json
 * slot 名：embedding | rerank | llm | judge
 */
export interface RagModelSlot {
  label?: string;
  api_base_url?: string;
  api_key?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  enable_thinking?: boolean | null;
}

/**
 * 单个 RAG 知识库的运行时参数。
 * 来源：GET/PUT /rag/knowledge-bases/:id/runtime-config
 * 持久化于 files/rag_kb_{id}/runtime_config.json
 */
export interface RagRuntimeConfig {
  temperature: number;
  /** 检索返回条数上限 */
  top_k: number;
  /** 送入 LLM 合成的来源条数上限（≤ top_k） */
  top_n: number;
  /** direct=直接返回最高分答案；generated=用 LLM 基于 sources 合成 */
  answer_mode: "direct" | "generated";
  use_rerank: boolean;
  /** 低于此置信度时可触发降级策略（由服务端 retriever 解释） */
  min_confidence_score: number;
  active_template_id: string;
  /** 可选的多套回答 prompt 模板 */
  templates: { id: string; name: string; content: string }[];
}

/**
 * RAG 批量评测汇总指标。
 * 来源：GET /rag/eval/runs/:runId 的 summary 字段
 */
export interface RagEvalSummary {
  count?: number;
  processed?: number;
  recall_at_1?: number;
  recall_at_3?: number;
  recall_at_5?: number;
  avg_quality?: number;
  avg_confidence?: number;
  /** 未命中或评测失败的样例列表 */
  failures?: { query?: string; expected_item_id?: string; actual_item_id?: string }[];
}

/**
 * RAG 评测任务一次运行的完整记录。
 * 来源：POST /rag/eval/run 创建，GET /rag/eval/runs/:runId 轮询
 * 结果文件存于 files/rag_kb_{id}/eval/
 */
export interface RagEvalRun {
  run_id: string;
  kb_id?: string;
  status: "queued" | "running" | "completed" | "failed" | string;
  /** 评测样本规模：10 | 50 | 100 */
  size?: number;
  /** 评测模式，如 mixed */
  mode?: string;
  top_k?: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  summary?: RagEvalSummary;
  /** 逐条样例的召回与质量分 */
  results?: {
    query?: string;
    expected_item_id?: string;
    actual_item_id?: string;
    /** key 为 K 值，value 表示 Recall@K 是否命中 */
    recall_at?: Record<number, boolean>;
    quality_score?: number;
    confidence?: number;
    error?: string;
  }[];
}
