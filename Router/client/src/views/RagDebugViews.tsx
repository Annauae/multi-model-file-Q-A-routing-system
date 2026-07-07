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
import { apiJson, fmtConfidence, fmtMs } from "../api/client";
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

function scrollToRagAnswer(index: number) {
  document.getElementById(`ragAnswer-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  setActiveNav,
  lastError = "",
}: {
  kbId: string;
  loading: boolean;
  chatResult: RagChatResponse | null;
  searchResults: RagSearchResult[];
  activeNav: number;
  setActiveNav: (i: number) => void;
  lastError?: string;
}) {
  const timing = chatResult?.timing as RagTimings | undefined;
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
    <div className="ragQaColumns modePanelEnter">
      <section className="ragCol ragColAnswer panel">
        <div className="stripHead">
          <span>RAG 回答</span>
          <span className="headActions">
            {chatResult && !isSearchOnly && <span className="pill">{chatResult.mode}</span>}
            {chatResult && chatResult.confidence > 0 && <span className="pill muted">{fmtConfidence(chatResult.confidence)}</span>}
            {sources.length > 0 && <span className="pill muted">{sources.length} 条</span>}
          </span>
        </div>
        <div className="ragColBody scrollInner ragAnswerList">
          {loading && !hasContent && <div className="empty">检索中…</div>}
          {!loading && !hasContent && !lastError && (
            <div className="empty">在左侧输入问题并点击「问答」或「检索」。</div>
          )}
          {!loading && !hasContent && lastError && (
            <div className="empty">{lastError}</div>
          )}
          {showGenerated && (
            <article className="answerCard ragAnswerCard fade-in">
              <div className="confidenceCardHead">
                <span className="id">合成回答</span>
              </div>
              <div className="answerCardBody mdPreview">
                <MarkdownPreview md={chatResult!.answer || ""} kbId={kbId} />
              </div>
              {timing && (
                <div className="ragTimingChips muted">
                  总 {fmtMs(timing.total_ms)} · 检索 {fmtMs(timing.search_ms)} · 生成 {fmtMs(timing.generate_ms)}
                </div>
              )}
            </article>
          )}
          {showPrimaryAnswer && (
            <article className="answerCard ragAnswerCard fade-in">
              <div className="confidenceCardHead">
                <span className="id">{chatResult!.mode === "no_high_confidence" ? "提示" : "RAG 回答"}</span>
              </div>
              <div className="answerCardBody mdPreview">
                <MarkdownPreview md={chatResult!.answer || ""} kbId={kbId} />
              </div>
              {timing && (
                <div className="ragTimingChips muted">
                  总 {fmtMs(timing.total_ms)} · 检索 {fmtMs(timing.search_ms)} · 生成 {fmtMs(timing.generate_ms)}
                </div>
              )}
            </article>
          )}
          {sources.length > 0 && (
            <div className="ragSourcesSectionHead muted">{isSearchOnly || showPrimaryAnswer ? "检索条目" : "来源条目"}</div>
          )}
          {sources.map((s, i) => (
            <article
              key={s.id + i}
              id={`ragAnswer-${i}`}
              className={`answerCard ragAnswerCard confidenceCard${i === activeNav ? " active" : ""}`}
              onClick={() => setActiveNav(i)}
            >
              <div className="confidenceCardHead">
                <span className="id">#{i + 1} {s.id}</span>
              </div>
              <ScorePills r={s} />
              <div className="confidenceQuestion">{s.question}</div>
              <div className="answerCardBody mdPreview">
                <MarkdownPreview md={s.answer || ""} kbId={kbId} />
              </div>
            </article>
          ))}
        </div>
      </section>

      <aside className="ragCol ragColNav panel">
        <div className="stripHead"><span>条目导航</span></div>
        <div className="ragColBody scrollInner nav-list">
          {!sources.length && <div className="empty">—</div>}
          {sources.map((s, i) => (
            <button
              key={s.id + i}
              type="button"
              className={`navItemBtn${i === activeNav ? " active" : ""}`}
              onClick={() => {
                setActiveNav(i);
                scrollToRagAnswer(i);
              }}
            >
              <span className="id">{s.id}</span>
              <span className="muted">{s.question?.slice(0, 24)}</span>
            </button>
          ))}
        </div>
      </aside>
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
