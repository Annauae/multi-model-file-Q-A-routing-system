import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiJson,
  DEBUG_ASK_TIMEOUT_S,
  isAskTimeoutError,
  streamAskConfidence,
} from "../api/client";
import { useAppUi } from "../context/AppUiContext";
import type {
  AskMode,
  AskTimings,
  CandidateAnswer,
  ConfidenceCandidate,
  RagChatResponse,
  RagSearchResult,
} from "../types";

export type AskChatTurn = {
  id: string;
  ts: number;
  question: string;
  mode: AskMode;
  loading: boolean;
  kbId: string;
  answers: CandidateAnswer[];
  candidates: ConfidenceCandidate[];
  timings: AskTimings | null;
  chatResult: RagChatResponse | null;
  searchResults: RagSearchResult[];
  lastError: string;
};

export type AskSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: AskChatTurn[];
};

const STORAGE_KEY = "ask_sessions_v2";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function newSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function newTurnId() {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function sessionTitle(question: string) {
  const q = question.trim();
  if (!q) return "新对话";
  return q.length > 28 ? `${q.slice(0, 28)}…` : q;
}

function emptyTurn(partial: Pick<AskChatTurn, "id" | "ts" | "question" | "mode" | "kbId">): AskChatTurn {
  return {
    ...partial,
    loading: true,
    answers: [],
    candidates: [],
    timings: null,
    chatResult: null,
    searchResults: [],
    lastError: "",
  };
}

function sanitizeTurn(t: AskChatTurn): AskChatTurn {
  if (!t.loading) return t;
  return { ...t, loading: false, lastError: t.lastError || "未完成" };
}

function sanitizeSession(s: AskSession): AskSession {
  return { ...s, turns: s.turns.map(sanitizeTurn) };
}

function loadRaw(): AskSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AskSession[];
    return Array.isArray(parsed) ? parsed.map(sanitizeSession) : [];
  } catch {
    return [];
  }
}

function prune(sessions: AskSession[]) {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return sessions.filter((s) => s.updatedAt >= cutoff);
}

function persist(sessions: AskSession[]) {
  const next = prune(sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function useAskSessions() {
  const { showToast } = useAppUi();
  const [sessions, setSessions] = useState<AskSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    setSessions(persist(loadRaw()));
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const turns = activeSession?.turns ?? [];

  const patchSessions = useCallback((updater: (prev: AskSession[]) => AskSession[]) => {
    setSessions((prev) => persist(updater(prev)));
  }, []);

  const updateSessionTurn = useCallback((sessionId: string, turnId: string, patch: Partial<AskChatTurn>) => {
    patchSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const turnsNext = s.turns.map((t) => (t.id === turnId ? { ...t, ...patch } : t));
        const firstQ = turnsNext[0]?.question;
        const title = s.title === "新对话" && firstQ ? sessionTitle(firstQ) : s.title;
        return { ...s, title, updatedAt: Date.now(), turns: turnsNext };
      }),
    );
  }, [patchSessions]);

  const ensureActiveSession = useCallback((): string => {
    if (activeSessionId && sessionsRef.current.some((s) => s.id === activeSessionId)) {
      return activeSessionId;
    }
    const session: AskSession = {
      id: newSessionId(),
      title: "新对话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
    };
    patchSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    return session.id;
  }, [activeSessionId, patchSessions]);

  const askLlm = useCallback(async (
    sessionId: string,
    turnId: string,
    question: string,
    kbId: string,
    profileId: string,
    topK: number,
  ) => {
    try {
      await streamAskConfidence({ question, kb_id: kbId, top_k: topK, match_profile_id: profileId }, (evt) => {
        if (evt.event === "candidates") {
          updateSessionTurn(sessionId, turnId, { candidates: (evt.data.candidates as ConfidenceCandidate[]) || [] });
        }
        if (evt.event === "done") {
          const d = evt.data as {
            answers?: CandidateAnswer[];
            match?: { candidates?: ConfidenceCandidate[] };
            timings?: AskTimings;
          };
          updateSessionTurn(sessionId, turnId, {
            answers: d.answers || [],
            candidates: d.match?.candidates || [],
            timings: d.timings || null,
            loading: false,
          });
        }
        if (evt.event === "error" && !evt.data?.timed_out) {
          showToast(String(evt.data.detail || "错误"), "error", 3200);
          updateSessionTurn(sessionId, turnId, { loading: false, lastError: String(evt.data.detail || "错误") });
        }
      });
    } catch (e) {
      if (isAskTimeoutError(e)) {
        showToast(`请求超时（${DEBUG_ASK_TIMEOUT_S}s）`, "error", 3200);
        updateSessionTurn(sessionId, turnId, { loading: false, lastError: "请求超时" });
      } else {
        showToast((e as Error).message, "error", 3200);
        updateSessionTurn(sessionId, turnId, { loading: false, lastError: (e as Error).message });
      }
    }
  }, [showToast, updateSessionTurn]);

  const askRag = useCallback(async (sessionId: string, turnId: string, question: string, kbId: string, topK: number) => {
    try {
      const data = await apiJson<RagChatResponse>("/rag/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: question, kb_id: kbId, top_n: topK }),
      });
      updateSessionTurn(sessionId, turnId, {
        chatResult: { ...data, query: data.query || question },
        searchResults: data.sources || [],
        loading: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(msg, "error");
      updateSessionTurn(sessionId, turnId, { loading: false, lastError: msg });
    }
  }, [showToast, updateSessionTurn]);

  const appendTurn = useCallback((sessionId: string, turn: AskChatTurn) => {
    patchSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const title = s.title === "新对话" ? sessionTitle(turn.question) : s.title;
        return { ...s, title, updatedAt: Date.now(), turns: [...s.turns, turn] };
      }),
    );
  }, [patchSessions]);

  const submit = useCallback(async (opts: {
    question: string;
    mode: AskMode;
    kbId: string;
    profileId: string;
    topK: number;
  }) => {
    const q = opts.question.trim();
    if (!q) { showToast("请输入问题", "error"); return null; }
    if (!opts.kbId) { showToast("请选择知识库", "error"); return null; }

    const sessionId = ensureActiveSession();
    const turn = emptyTurn({
      id: newTurnId(),
      ts: Date.now(),
      question: q,
      mode: opts.mode,
      kbId: opts.kbId,
    });
    appendTurn(sessionId, turn);
    setLoading(true);
    if (opts.mode === "llm") await askLlm(sessionId, turn.id, q, opts.kbId, opts.profileId, opts.topK);
    else await askRag(sessionId, turn.id, q, opts.kbId, opts.topK);
    setLoading(false);
    return turn;
  }, [appendTurn, askLlm, askRag, ensureActiveSession, showToast]);

  const searchRag = useCallback(async (opts: { question: string; kbId: string; topK: number }) => {
    const q = opts.question.trim();
    if (!q) { showToast("请输入问题", "error"); return null; }
    if (!opts.kbId) { showToast("请选择 RAG 知识库", "error"); return null; }

    const sessionId = ensureActiveSession();
    const turn = emptyTurn({
      id: newTurnId(),
      ts: Date.now(),
      question: q,
      mode: "rag",
      kbId: opts.kbId,
    });
    appendTurn(sessionId, turn);
    setLoading(true);
    try {
      const data = await apiJson<{
        query: string;
        results: RagSearchResult[];
        timing?: AskTimings;
      }>("/rag/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, kb_id: opts.kbId, top_k: opts.topK }),
      });
      const results = data.results || [];
      updateSessionTurn(sessionId, turn.id, {
        searchResults: results,
        chatResult: results.length ? {
          query: data.query || q,
          answer: "",
          confidence: 0,
          mode: "search",
          sources: results,
          timing: data.timing,
        } : null,
        loading: false,
        lastError: results.length ? "" : "未检索到匹配条目",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(msg, "error");
      updateSessionTurn(sessionId, turn.id, { loading: false, lastError: msg });
    }
    setLoading(false);
    return turn;
  }, [appendTurn, ensureActiveSession, showToast, updateSessionTurn]);

  const switchSession = useCallback((sessionId: string) => {
    if (!sessionsRef.current.some((s) => s.id === sessionId)) return;
    setActiveSessionId(sessionId);
  }, []);

  const startNewSession = useCallback(() => {
    setActiveSessionId(null);
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    patchSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setActiveSessionId((cur) => (cur === sessionId ? null : cur));
  }, [patchSessions]);

  return {
    sessions,
    activeSessionId,
    turns,
    loading,
    submit,
    searchRag,
    switchSession,
    startNewSession,
    deleteSession,
  };
}
