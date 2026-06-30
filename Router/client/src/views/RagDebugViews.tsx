import { useCallback, useState } from "react";
import { apiJson, fmtConfidence, fmtMs } from "../api/client";
import { MarkdownPreview } from "../components/MarkdownPreview";
import type { RagChatResponse, RagSearchResult, RagTimings } from "../types";

export function useRagAsk(kbId: string, topK: number) {
  const [loading, setLoading] = useState(false);
  const [chatResult, setChatResult] = useState<RagChatResponse | null>(null);
  const [searchResults, setSearchResults] = useState<RagSearchResult[]>([]);
  const [activeNav, setActiveNav] = useState(0);

  const reset = useCallback(() => {
    setChatResult(null);
    setSearchResults([]);
    setActiveNav(0);
  }, []);

  const chat = useCallback(async (query: string) => {
    if (!query.trim() || !kbId) return;
    setLoading(true);
    try {
      const data = await apiJson<RagChatResponse>("/rag/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, kb_id: kbId, top_n: topK }),
      });
      setChatResult(data);
      setSearchResults(data.sources || []);
      setActiveNav(0);
    } finally {
      setLoading(false);
    }
  }, [kbId, topK]);

  const search = useCallback(async (query: string) => {
    if (!query.trim() || !kbId) return;
    setLoading(true);
    try {
      const data = await apiJson<{ results: RagSearchResult[] }>("/rag/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, kb_id: kbId, top_k: topK }),
      });
      setSearchResults(data.results || []);
      setChatResult(null);
      setActiveNav(0);
    } finally {
      setLoading(false);
    }
  }, [kbId, topK]);

  return { loading, chatResult, searchResults, activeNav, setActiveNav, chat, search, reset };
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

export function RagQaMain({
  kbId,
  loading,
  chatResult,
  searchResults,
  activeNav,
  setActiveNav,
}: {
  kbId: string;
  loading: boolean;
  chatResult: RagChatResponse | null;
  searchResults: RagSearchResult[];
  activeNav: number;
  setActiveNav: (i: number) => void;
}) {
  const timing = chatResult?.timing as RagTimings | undefined;
  const sources = searchResults.length ? searchResults : (chatResult?.sources || []);

  return (
    <div className="ragQaColumns modePanelEnter">
      <section className="ragCol ragColAnswer panel">
        <div className="stripHead">
          <span>RAG 回答</span>
          <span className="headActions">
            {chatResult && <span className="pill">{chatResult.mode}</span>}
            {chatResult && <span className="pill muted">{fmtConfidence(chatResult.confidence)}</span>}
          </span>
        </div>
        <div className="ragColBody scrollInner">
          {loading && !chatResult && <div className="empty">检索中…</div>}
          {!loading && !chatResult && <div className="empty">在左侧输入问题并点击「问答」或「检索」。</div>}
          {chatResult && (
            <article className="answerCard fade-in">
              <div className="answerCardBody mdPreview">
                <MarkdownPreview md={chatResult.answer || ""} kbId={kbId} />
              </div>
              {timing && (
                <div className="ragTimingChips muted">
                  总 {fmtMs(timing.total_ms)} · 检索 {fmtMs(timing.search_ms)} · 生成 {fmtMs(timing.generate_ms)}
                </div>
              )}
            </article>
          )}
        </div>
      </section>

      <section className="ragCol ragColSources panel">
        <div className="stripHead"><span>检索来源</span><span className="pill muted">{sources.length}</span></div>
        <div className="ragColBody scrollInner sources-list">
          {!sources.length && <div className="empty">暂无检索结果</div>}
          {sources.map((s, i) => (
            <div
              key={s.id + i}
              id={`ragSource-${i}`}
              className={`confidenceCard ragSourceCard${i === activeNav ? " active" : ""}`}
              onClick={() => setActiveNav(i)}
            >
              <div className="confidenceCardHead">
                <span className="id">#{i + 1} {s.id}</span>
              </div>
              <ScorePills r={s} />
              <div className="confidenceQuestion">{s.question}</div>
              <div className="muted ragSourceSummary">{s.answer_summary?.slice(0, 120)}…</div>
            </div>
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
                document.getElementById(`ragSource-${i}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

export function RagTimingsPanel({ timing }: { timing?: RagTimings | null }) {
  if (!timing) return <div className="empty">提问后显示</div>;
  const rows = [
    ["embedding", timing.embedding_ms],
    ["vector", timing.vector_lookup_ms],
    ["keyword", timing.keyword_search_ms],
    ["fusion", timing.fusion_ms],
    ["rerank", timing.rerank_ms],
    ["generate", timing.generate_ms],
    ["total", timing.total_ms],
  ];
  return (
    <div className="timingPanel">
      {rows.map(([k, v]) => (
        <div key={k} className="timingRow"><span>{k}</span><span>{fmtMs(v as number)}</span></div>
      ))}
    </div>
  );
}
