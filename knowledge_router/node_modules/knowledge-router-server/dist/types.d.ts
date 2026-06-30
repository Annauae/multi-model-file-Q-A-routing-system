export interface QAItem {
    id: string;
    question: string;
    variants: string[];
    answer: string;
    enabled: boolean;
    updated_at: string;
}
export interface QuestionsDocument {
    version: number;
    items: QAItem[];
}
export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}
export interface PhaseTokens {
    phase: string;
    usage: TokenUsage;
}
export interface AskTimings {
    total_ms: number;
    prepare_ms: number;
    match_ms: number;
    match_first_token_ms: number;
    lookup_ms: number;
    match_output_tokens: number;
    tokens: TokenUsage;
    token_breakdown: PhaseTokens[];
}
export interface ConfidenceCandidate {
    id: string;
    confidence: number;
    question?: string;
}
export interface ConfidenceMatchResult {
    raw_output: string;
    candidates: ConfidenceCandidate[];
}
export interface CandidateAnswer {
    id: string;
    confidence: number;
    question: string;
    answer: string;
}
export interface ConfidenceAskResponse {
    question: string;
    kb_id: string;
    match: ConfidenceMatchResult;
    answer: string;
    answers: CandidateAnswer[];
    timings: AskTimings;
    cache_hit: boolean;
}
export interface RecallTestRow {
    id: string;
    question: string;
    run_at: string;
    candidates: ConfidenceCandidate[];
    answers: CandidateAnswer[];
    recalled: string;
    notes: string;
    match_profile_id: string;
    model_label: string;
    timings?: AskTimings;
}
export interface RecallTestDocument {
    items: RecallTestRow[];
}
export interface ModelSlotConfig {
    label: string;
    api_base_url: string;
    api_key: string;
    model: string;
    max_tokens: number;
    temperature: number;
    enable_thinking?: boolean | null;
}
export interface MatchProfile {
    id: string;
    name: string;
    api_base_url: string;
    api_key: string;
    model: string;
    max_tokens: number;
    temperature: number;
    enable_thinking?: boolean | null;
}
export interface GlobalPrompts {
    confidence_match_prompt: string;
    faq_generation_prompt: string;
    pdf_vlm_prompt: string;
    updated_at: string;
}
export interface KbMemoryIndex {
    itemsById: Map<string, QAItem>;
    enabledItems: QAItem[];
    validIds: Set<string>;
    confidenceSystemPrompt: string;
    loadedAt: string;
    sourceMtime: number;
}
export declare function emptyTimings(): AskTimings;
