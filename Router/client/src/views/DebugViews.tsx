/**
 * DebugViews.tsx — 调试 · 问答（LLM 模式）核心视图与 Hook
 *
 * 用户点击「提问」后的前端主路径：
 *   App.tsx 按钮 onClick
 *     → useDebugAsk().ask(question)
 *       → streamAskConfidence()  POST /ask/confidence/stream
 *         → SSE 事件 candidates / done
 *           → setAnswers / setCandidates / setTimings
 *             → DebugAnswersPanel / CandidatesPanel 重渲染
 */

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
import { useAppUi } from "../context/AppUiContext";

/**
 * 右侧主区「候选回答」列表。
 * 数据来源：useDebugAsk 在 SSE `done` 事件中写入的 answers 数组。
 * 每条含 id、confidence、question、answer（Markdown，由 MarkdownPreview 渲染）。
 */
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

/**
 * 左侧面板「候选匹配」Tab：展示 LLM 返回的 Top-K 候选及置信度进度条。
 * 数据在 SSE `candidates` 或 `done` 事件到达时更新；点击卡片滚动到右侧对应 answerCard。
 */
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

/**
 * LLM 调试问答 Hook — 用户点击「提问」时由 App.tsx 调用 ask(question)。
 *
 * @param kbId       当前选中的 LLM 知识库 id（来自 App 的 effectiveKb）
 * @param profileId  问答模型 profile id（来自 match_profiles 配置）
 * @param topK       返回候选数量上限（1–20，默认 5）
 *
 * 请求体示例（用户输入「怎么安装吊带」）：
 *   { question: "怎么安装吊带", kb_id: "1", top_k: 5, match_profile_id: "default" }
 */
export function useDebugAsk(kbId: string, profileId: string, topK: number) {
  const { showToast } = useAppUi();
  const [loading, setLoading] = useState(false);           // 控制按钮「提问中…」与右侧「匹配中…」
  const [candidates, setCandidates] = useState<ConfidenceCandidate[]>([]); // 左 Tab「候选匹配」
  const [answers, setAnswers] = useState<CandidateAnswer[]>([]);             // 右侧「候选回答」
  const [timings, setTimings] = useState<AskTimings | null>(null);           // 左 Tab「消耗时间/Token」

  const ask = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q) { showToast("请输入问题", "error"); return; }
    if (!kbId) { showToast("请选择知识库", "error"); return; }

    // ① 进入加载态，清空上次结果（用户会看到「匹配中…」）
    setLoading(true);
    setAnswers([]);
    setCandidates([]);
    setTimings(null);

    try {
      // ② 发起 SSE 流式请求；onEvent 在流式过程中被多次调用
      await streamAskConfidence({ question: q, kb_id: kbId, top_k: topK, match_profile_id: profileId }, (evt) => {
        // ③ 服务端 LLM 匹配完成后先发 candidates（含 raw_output、候选 id/confidence）
        if (evt.event === "candidates") setCandidates((evt.data.candidates as ConfidenceCandidate[]) || []);
        // ④ 最终 done 事件：带完整 answers（含 answer 正文）、timings
        if (evt.event === "done") {
          const d = evt.data as { answers?: CandidateAnswer[]; match?: { candidates?: ConfidenceCandidate[] }; timings?: AskTimings };
          setAnswers(d.answers || []);
          setCandidates(d.match?.candidates || []);
          setTimings(d.timings || null);
        }
        // ⑤ 非超时错误（如 LLM 鉴权失败）弹 Toast
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
      setLoading(false); // ⑥ 结束加载，DebugAnswersPanel 展示 answers
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
