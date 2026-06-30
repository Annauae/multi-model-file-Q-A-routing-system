import type { AskTimings } from "../types";
import { escapeHtml, fmtMs } from "../api/client";

export function TimingsPanel({
  timings,
  emptyText = "提问后显示",
  mode = "ask",
}: {
  timings: AskTimings | null;
  emptyText?: string;
  mode?: "ask" | "import";
}) {
  if (!timings) {
    return <div className="empty">{emptyText}</div>;
  }
  const chips =
    mode === "import"
      ? [
          ["总耗时", timings.total_ms],
          ["PDF/VLM 提取", timings.prepare_ms],
          ["LLM 生成", timings.match_ms],
        ]
      : [
          ["总耗时", timings.total_ms],
          ["准备(索引+prompt)", timings.prepare_ms],
          ["匹配(LLM)", timings.match_ms],
          ["首 token", timings.match_first_token_ms],
          ["查表(取 answer)", timings.lookup_ms],
        ];
  return (
    <>
      {chips.map(([label, val]) => {
        const n = Number(val);
        const display = Number.isFinite(n) && n >= 0 ? fmtMs(n) : "—";
        return (
          <div key={String(label)} className="timingChip">
            <span>{label}</span>
            <strong>{display}</strong>
          </div>
        );
      })}
    </>
  );
}

export function TokenPanel({ timings, emptyText = "提问后显示" }: { timings: AskTimings | null; emptyText?: string }) {
  if (!timings?.tokens) {
    return <div className="empty">{emptyText}</div>;
  }
  const t = timings.tokens;
  const chips = [
    ["总 Token", t.total_tokens],
    ["输入 Token", t.prompt_tokens],
    ["输出 Token", t.completion_tokens],
  ];
  return (
    <>
      {chips.map(([label, val]) => (
        <div key={String(label)} className="tokenChip">
          <span>{label}</span>
          <strong>{val ?? 0}</strong>
        </div>
      ))}
      {timings.token_breakdown?.length ? (
        <>
          <div className="muted tokenBreakdownHead">细分（各阶段）</div>
          {timings.token_breakdown.map((row) => {
            const u = row.usage || {};
            return (
              <div key={row.phase} className="tokenBreakdownRow">
                <div className="tokenBreakdownPhase">{row.phase}</div>
                <div className="tokenBreakdownStats">
                  <div className="tokenChip">
                    <span>输入 Token</span>
                    <strong>{u.prompt_tokens ?? 0}</strong>
                  </div>
                  <div className="tokenChip">
                    <span>输出 Token</span>
                    <strong>{u.completion_tokens ?? 0}</strong>
                  </div>
                </div>
              </div>
            );
          })}
        </>
      ) : null}
    </>
  );
}

export function TimeoutMetrics() {
  return <div className="metricTimeout">超时</div>;
}

export function escapeHtmlSafe(s: string) {
  return escapeHtml(s);
}
