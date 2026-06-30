import { useCallback, useEffect, useState } from "react";
import type { AskTimings, CandidateAnswer, ConfidenceCandidate, QAItem } from "../types";
import {
  apiJson,
  DEBUG_ASK_TIMEOUT_S,
  fmtConfidence,
  isAskTimeoutError,
  streamAskConfidence,
} from "../api/client";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { TimingsPanel, TokenPanel } from "../components/MetricsPanels";
import { useAppUi } from "../context/AppUiContext";

export function DebugAnswersPanel({
  kbId,
  loading,
  answers,
}: {
  kbId: string;
  loading: boolean;
  answers: CandidateAnswer[];
}) {
  if (loading && !answers.length) return <div className="empty">匹配中…</div>;
  if (!answers.length) return <div className="empty">在左侧栏输入问题并提问。</div>;
  return (
    <>
      {answers.map((a, i) => (
        <article key={a.id + i} className="answerCard fade-in" id={`debugAnswerCard-${i}`}>
          <div className="answerCardHead">
            <span><span className="id">#{i + 1} {a.id}</span> · {fmtConfidence(a.confidence)}</span>
            <span className="muted">{a.question || ""}</span>
          </div>
          <div className="answerCardBody mdPreview"><MarkdownPreview md={a.answer || "（无回答内容）"} kbId={kbId} /></div>
        </article>
      ))}
    </>
  );
}

export function CandidatesPanel({ candidates, onSelect }: { candidates: ConfidenceCandidate[]; onSelect: (i: number) => void }) {
  if (!candidates.length) return <div className="empty">未匹配到候选</div>;
  return (
    <>
      {candidates.map((c, i) => {
        const pct = Math.round(Number(c.confidence || 0) * 1000) / 10;
        return (
          <div key={c.id + i} className="confidenceCard" onClick={() => onSelect(i)}>
            <div className="confidenceCardHead"><span className="id">#{i + 1} {c.id}</span><span>{fmtConfidence(c.confidence)}</span></div>
            <div className="confidenceBar"><div className="confidenceBarFill" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
            <div className="confidenceQuestion">{c.question || ""}</div>
          </div>
        );
      })}
    </>
  );
}

export function useDebugAsk(kbId: string, profileId: string, topK: number) {
  const { showToast } = useAppUi();
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<ConfidenceCandidate[]>([]);
  const [answers, setAnswers] = useState<CandidateAnswer[]>([]);
  const [timings, setTimings] = useState<AskTimings | null>(null);

  const ask = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q) { showToast("请输入问题", "error"); return; }
    if (!kbId) { showToast("请选择知识库", "error"); return; }
    setLoading(true);
    setAnswers([]);
    setCandidates([]);
    setTimings(null);
    try {
      await streamAskConfidence({ question: q, kb_id: kbId, top_k: topK, match_profile_id: profileId }, (evt) => {
        if (evt.event === "candidates") setCandidates((evt.data.candidates as ConfidenceCandidate[]) || []);
        if (evt.event === "done") {
          const d = evt.data as { answers?: CandidateAnswer[]; match?: { candidates?: ConfidenceCandidate[] }; timings?: AskTimings };
          setAnswers(d.answers || []);
          setCandidates(d.match?.candidates || []);
          setTimings(d.timings || null);
        }
        if (evt.event === "error" && !evt.data?.timed_out) showToast(String(evt.data.detail || "错误"), "error", 3200);
      });
    } catch (e) {
      if (isAskTimeoutError(e)) {
        setAnswers([]);
        setCandidates([]);
        setTimings(null);
        showToast(`请求超时（${DEBUG_ASK_TIMEOUT_S}s）`, "error", 3200);
      } else showToast((e as Error).message, "error", 3200);
    } finally {
      setLoading(false);
    }
  }, [kbId, profileId, topK, showToast]);

  const reset = () => { setAnswers([]); setCandidates([]); setTimings(null); };

  return { loading, candidates, answers, timings, ask, reset };
}

export function useDebugQuestions(kbId: string) {
  const [cache, setCache] = useState<QAItem[]>([]);
  const load = useCallback(async () => {
    if (!kbId) return;
    const doc = await apiJson<{ items: QAItem[] }>(`/knowledge-bases/${encodeURIComponent(kbId)}/questions`);
    setCache(doc.items || []);
  }, [kbId]);
  useEffect(() => { void load(); }, [load]);
  const randomQuestion = () => {
    const enabled = cache.filter((x) => x.enabled !== false);
    if (!enabled.length) return "";
    const pick = enabled[Math.floor(Math.random() * enabled.length)];
    const variants = pick.variants || [];
    return variants.length ? variants[Math.floor(Math.random() * variants.length)] : pick.question;
  };
  return { load, randomQuestion };
}

export function RecallAnswerModalContent({ answers, kbId, question }: { answers: CandidateAnswer[]; kbId: string; question: string }) {
  return (
    <>
      <p className="muted">{question}</p>
      <div id="recallModalAnswers">
        {answers?.length ? answers.map((a, i) => (
          <article key={i} className="answerCard" style={{ marginTop: 10 }}>
            <div className="answerCardHead"><span className="id">#{i + 1} {a.id}</span> · {fmtConfidence(a.confidence)}</div>
            <div className="answerCardBody mdPreview"><MarkdownPreview md={a.answer || ""} kbId={kbId} /></div>
          </article>
        )) : <div className="empty">无候选回答</div>}
      </div>
    </>
  );
}
