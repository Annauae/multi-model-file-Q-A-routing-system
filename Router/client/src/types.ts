export type ModuleName = "debug" | "manage" | "logs" | "settings";
export type DebugSub = "single" | "recall";
export type ManageSub = "items" | "files";

export interface KnowledgeBase {
  kb_id: string;
  name: string;
  status?: string;
  match_prompt?: string;
  enabled_count?: number;
}

export interface QAItem {
  id: string;
  question: string;
  variants: string[];
  answer: string;
  enabled: boolean;
  updated_at?: string;
}

export interface QuestionsDocument {
  version: number;
  items: QAItem[];
}

export interface ConfidenceCandidate {
  id: string;
  confidence: number;
  question?: string;
}

export interface CandidateAnswer extends ConfidenceCandidate {
  answer: string;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface AskTimings {
  total_ms?: number;
  prepare_ms?: number;
  match_ms?: number;
  match_first_token_ms?: number;
  lookup_ms?: number;
  vlm_refine_ms?: number;
  tokens?: TokenUsage;
  token_breakdown?: { phase: string; usage: TokenUsage }[];
}

export interface MatchProfile {
  id: string;
  name: string;
  model: string;
  api_base_url: string;
  api_key: string;
  enable_thinking?: boolean | null;
  max_tokens?: number;
}

export interface RecallTestRow {
  id: string;
  question: string;
  recalled: "yes" | "no" | "";
  last_run_at?: string;
  last_top_id?: string;
  last_confidence?: number;
}

export interface FileTreeNode {
  type?: "folder" | "file";
  name: string;
  path?: string;
  kind?: string;
  format?: string;
  line_count?: number;
  children?: FileTreeNode[];
  capabilities?: {
    editable?: boolean;
    preview_only?: boolean;
    can_convert?: boolean;
    direct_question_gen?: boolean;
    default_vlm_refine?: boolean;
  };
}

export interface ImportSelection {
  id: string;
  lineStart: number;
  lineEnd: number;
  question: string;
  variants: string[];
  answer: string;
}

export interface LogEntry {
  ts: string;
  module: string;
  action: string;
  kb_id?: string;
  detail?: string;
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export type AskMode = "llm" | "rag";

export interface RagSearchResult {
  id: string;
  question: string;
  answer: string;
  answer_summary?: string;
  vector_score?: number;
  keyword_score?: number;
  rrf_score?: number;
  rerank_score?: number;
  matched_doc_types?: string[];
  images?: { src: string; url: string; alt?: string }[];
}

export interface RagTimings {
  embedding_ms?: number;
  vector_lookup_ms?: number;
  keyword_search_ms?: number;
  fusion_ms?: number;
  rerank_ms?: number;
  generate_ms?: number;
  search_ms?: number;
  total_ms?: number;
}

export interface RagChatResponse {
  query: string;
  answer: string;
  confidence: number;
  mode: string;
  sources: RagSearchResult[];
  images?: { src: string; url: string; alt?: string }[];
  timing?: RagTimings;
  tokens?: TokenUsage;
  token_breakdown?: { phase: string; usage: TokenUsage }[];
}

export interface RagModelSlot {
  label?: string;
  api_base_url?: string;
  api_key?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  enable_thinking?: boolean | null;
}

export interface RagRuntimeConfig {
  temperature: number;
  top_k: number;
  top_n: number;
  answer_mode: "direct" | "generated";
  use_rerank: boolean;
  min_confidence_score: number;
  active_template_id: string;
  templates: { id: string; name: string; content: string }[];
}

export interface RagEvalSummary {
  count?: number;
  processed?: number;
  recall_at_1?: number;
  recall_at_3?: number;
  recall_at_5?: number;
  avg_quality?: number;
  avg_confidence?: number;
  failures?: { query?: string; expected_item_id?: string; actual_item_id?: string }[];
}

export interface RagEvalRun {
  run_id: string;
  kb_id?: string;
  status: "queued" | "running" | "completed" | "failed" | string;
  size?: number;
  mode?: string;
  top_k?: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  summary?: RagEvalSummary;
  results?: {
    query?: string;
    expected_item_id?: string;
    actual_item_id?: string;
    recall_at?: Record<number, boolean>;
    quality_score?: number;
    confidence?: number;
    error?: string;
  }[];
}
