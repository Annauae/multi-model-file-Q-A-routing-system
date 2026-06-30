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
  line_count?: number;
  children?: FileTreeNode[];
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
