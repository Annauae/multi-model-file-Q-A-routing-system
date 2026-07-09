import { fmtMs } from "../api/client";
import type { AskTimings, RagChatResponse } from "../types";

function joinParts(parts: string[]) {
  return parts.filter(Boolean).join(" · ");
}

export function LlmMetricsFooter({ timings }: { timings: AskTimings | null }) {
  if (!timings) return null;
  const parts: string[] = [];
  if (timings.total_ms != null) parts.push(`总耗时 ${fmtMs(timings.total_ms)}`);
  if (Number(timings.prepare_ms) > 0) parts.push(`准备 ${fmtMs(timings.prepare_ms)}`);
  if (Number(timings.match_ms) > 0) parts.push(`匹配 ${fmtMs(timings.match_ms)}`);
  if (Number(timings.match_first_token_ms) > 0) parts.push(`首 token ${fmtMs(timings.match_first_token_ms)}`);
  if (Number(timings.lookup_ms) > 0) parts.push(`查表 ${fmtMs(timings.lookup_ms)}`);
  if (timings.tokens?.total_tokens != null) {
    parts.push(`Token ${timings.tokens.total_tokens}`);
    if (timings.tokens.prompt_tokens != null) parts.push(`输入 ${timings.tokens.prompt_tokens}`);
    if (timings.tokens.completion_tokens != null) parts.push(`输出 ${timings.tokens.completion_tokens}`);
  }
  if (!parts.length) return null;
  return <div className="answerMetrics">{joinParts(parts)}</div>;
}

export function RagMetricsFooter({ chatResult }: { chatResult: RagChatResponse | null }) {
  if (!chatResult) return null;
  const timing = chatResult.timing;
  const parts: string[] = [];
  if (timing?.total_ms != null) parts.push(`总耗时 ${fmtMs(timing.total_ms)}`);
  if (Number(timing?.search_ms) > 0) parts.push(`检索 ${fmtMs(timing.search_ms)}`);
  if (Number(timing?.generate_ms) > 0) parts.push(`生成 ${fmtMs(timing.generate_ms)}`);
  if (chatResult.tokens?.total_tokens != null) {
    parts.push(`Token ${chatResult.tokens.total_tokens}`);
    if (chatResult.tokens.prompt_tokens != null) parts.push(`输入 ${chatResult.tokens.prompt_tokens}`);
    if (chatResult.tokens.completion_tokens != null) parts.push(`输出 ${chatResult.tokens.completion_tokens}`);
  }
  if (!parts.length) return null;
  return <div className="answerMetrics">{joinParts(parts)}</div>;
}
