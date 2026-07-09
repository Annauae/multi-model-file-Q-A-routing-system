/**
 * RagDebugViews.tsx — 调试 · 问答（RAG 模式）核心视图与 Hook
 *
 * 用户切换到 RAG 并点击「问答」后的主路径：
 *   App.tsx ModeBar 切换 debugMode → "rag"
 *     → useRagAsk().chat("怎么调光圈")
 *       → apiJson POST /rag/chat
 *         → ragRoutes.js → RagRetriever.chat()
 *           → search（embedding + 向量 + 关键词 + RRF + rerank）
 *           → direct 或 generated 返回答案
 *       → setChatResult / setSearchResults
 *         → RagQaMain 渲染合成回答与来源条目
 */

import { useCallback, useState } from "react";
import { apiJson, fmtMs } from "../api/client";
import { RagMetricsFooter } from "../components/AnswerMetricsFooter";
import { TokenPanel, RAG_PHASE_LABELS } from "../components/MetricsPanels";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { useAppUi } from "../context/AppUiContext";
import type { RagChatResponse, RagSearchResult, RagTimings, TokenUsage } from "../types";

/**
 * RAG 调试问答 Hook — 用户点击「问答」或「检索」时由 App.tsx 调用。
 *
 * @param kbId  当前选中的 RAG 知识库 id（来自 App 的 effectiveKb / debugRagKb）
 * @param topK  检索返回条数上限（传给后端的 top_n 或 top_k）
 *
 * 「问答」走 POST /rag/chat（检索 + 置信判定 + 直出/合成）
 * 「检索」走 POST /rag/search（仅检索排序，不生成合成回答）
 */
export function useRagAsk(kbId: string, topK: number) {
  const { showToast } = useAppUi();
  const [loading, setLoading] = useState(false);
  const [chatResult, setChatResult] = useState<RagChatResponse | null>(null);
  const [searchResults, setSearchResults] = useState<RagSearchResult[]>([]);
  const [activeNav, setActiveNav] = useState(0);
  const [lastError, setLastError] = useState("");

  const reset = useCallback(() => {
    setChatResult(null);
    setSearchResults([]);
    setActiveNav(0);
    setLastError("");
  }, []);

  /**
   * RAG 完整问答 — 用户点击「问答」按钮时调用。
   * 例：query="怎么调光圈", kb_id="1", top_n=5
   * 后端返回 mode=direct|generated|no_high_confidence 及 sources、answer、timing
   */
  const chat = useCallback(async (query: string) => {
    if (!query.trim()) {
      showToast("请输入问题", "error");
      return;
    }
    if (!kbId) {
      showToast("请选择 RAG 知识库", "error");
      return;
    }
    setLoading(true);
    setLastError("");
    try {
      const data = await apiJson<RagChatResponse>("/rag/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, kb_id: kbId, top_n: topK }),
      });
      setChatResult({ ...data, query: data.query || query });
      setSearchResults(data.sources || []);
      setActiveNav(0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [kbId, topK, showToast]);

  const search = useCallback(async (query: string) => {
    if (!query.trim()) {
      showToast("请输入问题", "error");
      return;
    }
    if (!kbId) {
      showToast("请选择 RAG 知识库", "error");
      return;
    }
    setLoading(true);
    setLastError("");
    try {
      const data = await apiJson<{
        query: string;
        results: RagSearchResult[];
        timing?: RagTimings;
        tokens?: TokenUsage;
        token_breakdown?: { phase: string; usage: TokenUsage }[];
      }>("/rag/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, kb_id: kbId, top_k: topK }),
      });
      const results = data.results || [];
      setSearchResults(results);
      setChatResult(results.length ? {
        query: data.query || query,
        answer: "",
        confidence: 0,
        mode: "search",
        sources: results,
        timing: data.timing,
        tokens: data.tokens,
        token_breakdown: data.token_breakdown,
      } : null);
      setActiveNav(0);
      if (!results.length) setLastError("未检索到匹配条目");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      setChatResult(null);
      setSearchResults([]);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [kbId, topK, showToast]);

  return { loading, chatResult, searchResults, activeNav, setActiveNav, lastError, chat, search, reset };
}

function ScorePills({ r }: { r: RagSearchResult }) {
  const pills = [
    ["rerank", r.rerank_score],
    ["rrf", r.rrf_score],
    ["vec", r.vector_score],
    ["kw", r.keyword_score],
  ].filter(([, v]) => v != null && Number(v) > 0);
  return (
    <span className="ragScorePills">
      {pills.map(([k, v]) => (
        <span key={k} className="pill muted">{k} {Number(v).toFixed(3)}</span>
      ))}
    </span>
  );
}

export function scrollToCard(cardId: string) {
  document.getElementById(cardId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** @deprecated use scrollToCard */
export function scrollToRagAnswer(index: number) {
  scrollToCard(`ragAnswer-${index}`);
}

export function RagTurnSection({
  turn,
  kbId,
  activeCardId,
}: {
  turn: import("../hooks/useAskSessions").AskChatTurn;
  kbId: string;
  activeCardId?: string;
}) {
  const sources = turn.searchResults.length ? turn.searchResults : (turn.chatResult?.sources || []);
  const chatResult = turn.chatResult;
  const isSearchOnly = chatResult?.mode === "search";
  const showGenerated = chatResult?.mode === "generated" && chatResult.answer;
  const showPrimaryAnswer = Boolean(chatResult?.answer && !isSearchOnly && chatResult.mode === "no_high_confidence");
  const hasContent = showGenerated || showPrimaryAnswer || sources.length > 0;
  return (
    <section id={`ask-turn-${turn.id}`} className="askTurnBlock ui-fade-in-up">
      <div className="userBubble">{turn.question}</div>
      {turn.loading && !hasContent && <div className="askLoadingBubble ui-fade-in">检索中…</div>}
      {!turn.loading && !hasContent && turn.lastError && <div className="askEmptyState">{turn.lastError}</div>}
      {showGenerated && (
        <article className="answerCard askAnswerCard fade-in" id={`ragAnswer-${turn.id}-gen`}>
          <div className="askAnswerHead">
            <span className="askAvatar" aria-hidden>AI</span>
            <span className="askAnswerMeta"><span className="id">合成回答</span></span>
          </div>
          <div className="answerCardBody mdPreview">
            <MarkdownPreview md={chatResult!.answer || ""} kbId={kbId} />
          </div>
        </article>
      )}
      {showPrimaryAnswer && (
        <article className="answerCard askAnswerCard fade-in" id={`ragAnswer-${turn.id}-primary`}>
          <div className="askAnswerHead">
            <span className="askAvatar" aria-hidden>AI</span>
            <span className="askAnswerMeta">
              <span className="id">{chatResult!.mode === "no_high_confidence" ? "提示" : "RAG 回答"}</span>
            </span>
          </div>
          <div className="answerCardBody mdPreview">
            <MarkdownPreview md={chatResult!.answer || ""} kbId={kbId} />
          </div>
        </article>
      )}
      {sources.length > 0 && (
        <div className="ragSourcesSectionHead muted">{isSearchOnly || showPrimaryAnswer ? "检索条目" : "来源条目"}</div>
      )}
      {sources.map((s, i) => {
        const cardId = `ragAnswer-${turn.id}-${i}`;
        return (
          <article
            key={s.id + i}
            id={cardId}
            className={`answerCard askAnswerCard ragAnswerCard${activeCardId === cardId ? " active" : ""}`}
          >
            <div className="askAnswerHead">
              <span className="askAvatar muted" aria-hidden>#{i + 1}</span>
              <span className="askAnswerMeta"><span className="id">{s.id}</span></span>
            </div>
            <ScorePills r={s} />
            <div className="askAnswerQuestion">{s.question}</div>
            <div className="answerCardBody mdPreview">
              <MarkdownPreview md={s.answer || ""} kbId={kbId} />
            </div>
          </article>
        );
      })}
      {!turn.loading && hasContent && <RagMetricsFooter chatResult={chatResult} />}
    </section>
  );
}

export function RagChatThread({
  turns,
  kbId,
  activeCardId,
}: {
  turns: import("../hooks/useAskSessions").AskChatTurn[];
  kbId: string;
  activeCardId?: string;
}) {
  return (
    <div className="askChatThread">
      {turns.filter((t) => t.mode === "rag").map((turn) => (
        <RagTurnSection key={turn.id} turn={turn} kbId={kbId} activeCardId={activeCardId} />
      ))}
    </div>
  );
}

/**
 * RAG 调试页右侧主区：合成回答 + 来源条目列表 + 条目导航。
 * mode=generated 时顶部显示 LLM 合成回答；mode=direct 时主要展示 Top1 来源；
 * mode=no_high_confidence 时显示低置信提示 + 候选来源。
 */
export function RagQaMain({
  kbId,
  loading,
  chatResult,
  searchResults,
  activeNav,
  lastError = "",
  askedQuestion = "",
}: {
  kbId: string;
  loading: boolean;
  chatResult: RagChatResponse | null;
  searchResults: RagSearchResult[];
  activeNav: number;
  setActiveNav?: (i: number) => void;
  lastError?: string;
  askedQuestion?: string;
}) {
  const sources = searchResults.length ? searchResults : (chatResult?.sources || []);
  const isSearchOnly = chatResult?.mode === "search";
  const showGenerated = chatResult?.mode === "generated" && chatResult.answer;
  const showPrimaryAnswer = Boolean(
    chatResult?.answer
    && !isSearchOnly
    && chatResult.mode === "no_high_confidence",
  );
  const hasContent = showGenerated || showPrimaryAnswer || sources.length > 0;

  return (
    <div className="askChatThread">
      {askedQuestion && <div className="userBubble ui-fade-in-up">{askedQuestion}</div>}
      {loading && !hasContent && <div className="askLoadingBubble ui-fade-in">检索中…</div>}
      {!loading && !hasContent && lastError && <div className="askEmptyState">{lastError}</div>}
      {showGenerated && (
        <article className="answerCard askAnswerCard fade-in">
          <div className="askAnswerHead">
            <span className="askAvatar" aria-hidden>AI</span>
            <span className="askAnswerMeta"><span className="id">合成回答</span></span>
          </div>
          <div className="answerCardBody mdPreview">
            <MarkdownPreview md={chatResult!.answer || ""} kbId={kbId} />
          </div>
        </article>
      )}
      {showPrimaryAnswer && (
        <article className="answerCard askAnswerCard fade-in">
          <div className="askAnswerHead">
            <span className="askAvatar" aria-hidden>AI</span>
            <span className="askAnswerMeta">
              <span className="id">{chatResult!.mode === "no_high_confidence" ? "提示" : "RAG 回答"}</span>
            </span>
          </div>
          <div className="answerCardBody mdPreview">
            <MarkdownPreview md={chatResult!.answer || ""} kbId={kbId} />
          </div>
        </article>
      )}
      {sources.length > 0 && (
        <div className="ragSourcesSectionHead muted">{isSearchOnly || showPrimaryAnswer ? "检索条目" : "来源条目"}</div>
      )}
      {sources.map((s, i) => (
        <article
          key={s.id + i}
          id={`ragAnswer-${i}`}
          className={`answerCard askAnswerCard ragAnswerCard${i === activeNav ? " active" : ""}`}
        >
          <div className="askAnswerHead">
            <span className="askAvatar muted" aria-hidden>#{i + 1}</span>
            <span className="askAnswerMeta"><span className="id">{s.id}</span></span>
          </div>
          <ScorePills r={s} />
          <div className="askAnswerQuestion">{s.question}</div>
          <div className="answerCardBody mdPreview">
            <MarkdownPreview md={s.answer || ""} kbId={kbId} />
          </div>
        </article>
      ))}
      {!loading && hasContent && <RagMetricsFooter chatResult={chatResult} />}
    </div>
  );
}

const RAG_TIMING_ROWS: [string, string][] = [
  ["embedding", "向量嵌入"],
  ["vector", "向量检索"],
  ["keyword", "关键词检索"],
  ["fusion", "结果融合"],
  ["rerank", "重排序"],
  ["generate", "答案生成"],
  ["total", "总计"],
];

export function RagTimingsPanel({ timing }: { timing?: RagTimings | null }) {
  if (!timing) return <div className="empty">提问后显示</div>;
  const fieldMap: Record<string, number | undefined> = {
    embedding: timing.embedding_ms,
    vector: timing.vector_lookup_ms,
    keyword: timing.keyword_search_ms,
    fusion: timing.fusion_ms,
    rerank: timing.rerank_ms,
    generate: timing.generate_ms,
    total: timing.total_ms,
  };
  return (
    <div className="timingPanel">
      {RAG_TIMING_ROWS.map(([key, labelZh]) => (
        <div key={key} className="timingRow">
          <span>{key} <span className="muted timingLabelZh">{labelZh}</span></span>
          <span>{fmtMs(fieldMap[key])}</span>
        </div>
      ))}
    </div>
  );
}

export function RagTokenPanel({ chatResult }: { chatResult: RagChatResponse | null }) {
  if (!chatResult?.tokens) {
    return <div className="empty">提问后显示</div>;
  }
  const hint = chatResult.mode === "direct"
    ? "直出模式：未调用 RAG 问答模型。"
    : chatResult.mode === "generated"
      ? "合成模式：含 RAG 问答模型消耗。"
      : undefined;
  const timings = {
    tokens: chatResult.tokens,
    token_breakdown: chatResult.token_breakdown,
  };
  return (
    <div className="tokenPanel">
      <TokenPanel
        timings={timings}
        emptyText="提问后显示"
        phaseLabels={RAG_PHASE_LABELS}
        hint={hint}
      />
    </div>
  );
}
