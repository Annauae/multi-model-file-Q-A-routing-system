import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "../api/client";
import type { RagEvalRun } from "../types";

const EVAL_MODES: { id: string; label: string; hint: string }[] = [
  { id: "mixed", label: "混合模式", hint: "主问题 + 预留相似问法合并抽样，贴近真实提问分布。" },
  { id: "holdout_variant", label: "预留相似问法", hint: "测试句未建索引，指标最可信。" },
  { id: "question", label: "主问题", hint: "用 FAQ 主问题原文测试，适合冒烟与基线。" },
  { id: "indexed_variant", label: "已索引相似问法", hint: "用已写入索引的 variants 测试。" },
];

function pct(n?: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function RagEvalModal({ kbId, topK }: { kbId: string; topK: number }) {
  const [mode, setMode] = useState("mixed");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<RagEvalRun | null>(null);
  const [history, setHistory] = useState<RagEvalRun[]>([]);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadHistory = useCallback(async () => {
    if (!kbId) return;
    try {
      const data = await apiJson<{ runs: RagEvalRun[] }>(`/rag/eval/runs?kb_id=${encodeURIComponent(kbId)}&limit=8`);
      setHistory(data.runs || []);
    } catch {
      setHistory([]);
    }
  }, [kbId]);

  useEffect(() => {
    void loadHistory();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [loadHistory]);

  const pollRun = useCallback((runId: string) => {
    const tick = async () => {
      try {
        const data = await apiJson<RagEvalRun>(`/rag/eval/runs/${encodeURIComponent(runId)}?kb_id=${encodeURIComponent(kbId)}`);
        setRun(data);
        if (data.status === "running" || data.status === "queued") {
          pollRef.current = setTimeout(tick, 1500);
        } else {
          setRunning(false);
          void loadHistory();
        }
      } catch {
        setRunning(false);
      }
    };
    void tick();
  }, [kbId, loadHistory]);

  const startEval = async (size: number) => {
    if (!kbId) return;
    setRunning(true);
    setRun(null);
    try {
      const data = await apiJson<{ run_id: string }>("/rag/eval/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kb_id: kbId, size, mode, top_k: topK }),
      });
      pollRun(data.run_id);
    } catch {
      setRunning(false);
    }
  };

  const s = run?.summary || {};
  const processed = s.processed ?? run?.results?.length ?? 0;
  const total = run?.size ?? 0;
  const modeHint = EVAL_MODES.find((m) => m.id === mode)?.hint || "";

  return (
    <div className="ragEvalModal">
      <p className="muted">从 RAG FAQ 随机抽样，批量跑 Recall@K 与质量评测。</p>
      <label className="fieldLabel">
        评测模式
        <select className="settingsInput" value={mode} onChange={(e) => setMode(e.target.value)}>
          {EVAL_MODES.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </label>
      <p className="muted ragEvalModeHint">{modeHint} 每次从候选池随机抽取指定数量。</p>
      <div className="ragEvalSizeBtns">
        {[10, 50, 100].map((size) => (
          <button key={size} type="button" className="btn btnXs primary" disabled={running || !kbId} onClick={() => void startEval(size)}>
            {size} 条
          </button>
        ))}
      </div>
      {run && (
        <div className="ragEvalSummary fade-in">
          <div className="ragEvalSummaryHead">
            <span className={`pill indexStatusPill ${run.status === "completed" ? "ready" : run.status === "failed" ? "missing" : "stale"}`}>
              {run.status === "completed" ? "已完成" : run.status === "running" ? "运行中…" : run.status || "—"}
            </span>
            <span className="muted">{processed}/{total}</span>
          </div>
          <div className="ragEvalMetrics">
            <span>Recall@1 <b>{pct(s.recall_at_1)}</b></span>
            <span>Recall@5 <b>{pct(s.recall_at_5)}</b></span>
            <span>质量 <b>{Number(s.avg_quality || 0).toFixed(2)}</b></span>
            <span>置信 <b>{Number(s.avg_confidence || 0).toFixed(2)}</b></span>
          </div>
          {(run.results || []).slice(0, 5).map((r, i) => (
            <div key={i} className="ragEvalResultRow muted">
              {r.query?.slice(0, 40)}… → {r.actual_item_id || "—"}
              {r.recall_at?.[1] ? " ✓" : " ✗"}
            </div>
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div className="ragEvalHistory">
          <span className="recallFieldLabel">最近评测</span>
          {history.map((h) => (
            <button key={h.run_id} type="button" className="btn btnXs ghost ragEvalHistoryBtn" onClick={() => {
              setRun(h);
              if (h.status === "running" || h.status === "queued") pollRun(h.run_id);
            }}>
              {h.run_id} · {h.mode} · {h.size}条 · Recall@1 {pct(h.summary?.recall_at_1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
