/**
 * App.tsx — 知识问答控制台根组件
 *
 * 职责：
 * 1. 提供全局 Provider（React Query 数据缓存、Toast/Modal UI 上下文）
 * 2. 渲染整体布局：侧边栏导航 + 顶栏 + 主内容区
 * 3. 按「模块 × 子页」切换视图：调试（问答/召回度）、管理、日志、设置
 * 4. 调试 · 问答页支持 LLM 语义匹配 与 RAG 检索 两种模式，共享左侧面板布局
 *
 * 布局结构（调试 · 问答）：
 * ┌──────────┬─────────────────┬──────────────────┐
 * │ sidebar  │  leftPanel      │  mainContent     │
 * │ 导航     │  提问/配置/指标  │  候选回答/RAG结果 │
 * └──────────┴─────────────────┴──────────────────┘
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppUiProvider, ModalOverlay, ToastContainer } from "./context/AppUiContext";
import { useHealth, useKnowledgeBases, useMatchProfiles, useRagKnowledgeBases } from "./hooks/useKnowledgeBases";
import { DocsModal } from "./components/DocsModal";
import { AskComposer } from "./components/AskComposer";
import { AskChatThread } from "./components/AskChatThread";
import { GroupedAnswerNavPanel, type AnswerNavGroup } from "./components/AnswerNavPanel";
import { AskSessionsPanel, AskSessionsExpandBtn } from "./components/AskSessionsPanel";
import { useAskSessions, type AskChatTurn } from "./hooks/useAskSessions";
import { useDebugQuestions } from "./views/DebugViews";
import { scrollToCard } from "./views/RagDebugViews";
import { ManageView } from "./views/ManageView";
import { LogsView } from "./views/LogsView";
import { SettingsView } from "./views/SettingsView";
import { RecallModule } from "./views/DebugRecallView";
import type { AskMode, DebugSub, ManageSub, ModuleName } from "./types";
import "./styles.css";

/** 一级模块在面包屑中的中文标签 */
const MODULE_LABELS: Record<ModuleName, string> = { debug: "调试", manage: "管理", logs: "日志", settings: "设置" };
/** 调试模块下的二级子页标签 */
const SUB_LABELS: Record<DebugSub, string> = { single: "问答", recall: "召回度测试" };
/** 管理模块下的二级子页标签 */
const MANAGE_SUB_LABELS: Record<ManageSub, string> = { items: "问题管理", files: "文件管理" };

/**
 * 顶栏面包屑：根据当前模块与子页动态拼接路径
 * 例：首页 / 调试 / 问答、首页 / 管理 / 文件管理
 */
function Breadcrumb({ module, debugSub, manageSub }: { module: ModuleName; debugSub: DebugSub; manageSub: ManageSub }) {
  let html = `首页 / <strong>${MODULE_LABELS[module]}</strong>`;
  if (module === "debug") html += ` / ${SUB_LABELS[debugSub]}`;
  if (module === "manage") html += ` / ${MANAGE_SUB_LABELS[manageSub]}`;
  // 使用 innerHTML 以便 <strong> 渲染加粗；内容均为内部常量，无 XSS 风险
  return <div className="breadcrumb" id="breadcrumb" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * AppShell — 应用主壳，包含全部业务 UI 与局部状态
 *
 * 状态分层：
 * - 路由级：module / debugSub / manageSub（决定显示哪个视图）
 * - 调试级：debugMode（llm | rag）、知识库选择、Top K、问题文本
 * - UI 级：右侧面板 Tab、手册弹窗、侧边栏折叠
 */
function AppShell() {
  // ── 服务端数据（React Query 缓存，见 hooks/useKnowledgeBases.ts）──
  const { data: health } = useHealth(); // GET /health，驱动右上角连接状态
  const { kbMap } = useKnowledgeBases(); // LLM 知识库下拉选项
  const { kbMap: ragKbMap } = useRagKnowledgeBases(); // RAG 知识库下拉选项
  const { data: profilesData } = useMatchProfiles(); // 「问答模型」下拉选项（match_profiles）

  // ── 导航状态 
  const [module, setModule] = useState<ModuleName>("debug"); // 一级模块：调试、管理、日志、设置
  const [debugSub, setDebugSub] = useState<DebugSub>("single"); // 二级模块：问答、召回度测试
  const [manageSub, setManageSub] = useState<ManageSub>("items"); // 二级模块：问题管理、文件管理
  const [docsOpen, setDocsOpen] = useState(false); // 使用手册弹窗是否打开
  const [debugNavCollapsed, setDebugNavCollapsed] = useState(false); // 侧边栏「调试」分组折叠
  const [debugMode, setDebugMode] = useState<AskMode>("llm"); // 问答模式：LLM 匹配 | RAG 检索
  const [activeCardId, setActiveCardId] = useState("");
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatSession = useAskSessions();

  // 知识库 id 按数字排序，保证下拉顺序稳定
  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));
  const ragKbIds = Object.keys(ragKbMap).sort((a, b) => Number(a) - Number(b));

  // ── 调试 · 问答表单状态 ──
  const [debugKb, setDebugKb] = useState(""); // LLM 知识库（用户选择使用哪个LLM知识库，空则 fallback 到 kbIds[0]）
  const [debugRagKb, setDebugRagKb] = useState(""); // RAG 知识库（用户选择使用哪个RAG知识库，空则 fallback 到 ragKbIds[0]）
  const [debugProfile, setDebugProfile] = useState(""); // 问答模型 profile id（用户选择使用哪个问答模型，空则默认default_id或首项）
  const [debugTopK, setDebugTopK] = useState(5); // Top K，范围 1–20
  const [question, setQuestion] = useState(""); // 问题输入框内容

  /** 当前模式下实际生效的知识库 id（用户未选时用列表首项） */
  const effectiveKb = debugMode === "rag" ? (debugRagKb || ragKbIds[0] || "") : (debugKb || kbIds[0] || "");
  const profiles = profilesData?.profiles || [];

  /** 当前生效的问答模型 profile（用户未选时用 default_id 或首项） */
  const effectiveProfile = debugProfile || profilesData?.default_id || profiles[0]?.id || "";

  const debugQuestions = useDebugQuestions(debugKb || kbIds[0] || ""); // 「随机问题」从 LLM 库抽样

  const scrollChatToBottom = () => {
    requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  };

  const submitAsk = async () => {
    const q = question.trim();
    if (!q) return;
    const turn = await chatSession.submit({
      question: q,
      mode: debugMode,
      kbId: effectiveKb,
      profileId: effectiveProfile,
      topK: debugTopK,
    });
    if (!turn) return;
    setQuestion("");
    scrollChatToBottom();
  };

  const submitSearch = async () => {
    const q = question.trim();
    if (!q) return;
    const turn = await chatSession.searchRag({ question: q, kbId: effectiveKb, topK: debugTopK });
    if (!turn) return;
    setQuestion("");
    scrollChatToBottom();
  };

  const resetAskSession = () => {
    setQuestion("");
    setActiveCardId("");
    chatSession.startNewSession();
  };

  const selectSession = (sessionId: string) => {
    setActiveCardId("");
    setQuestion("");
    chatSession.switchSession(sessionId);
  };

  useEffect(() => {
    if (chatSession.turns.length > 0) scrollChatToBottom();
  }, [chatSession.activeSessionId]);

  const switchDebugMode = (m: AskMode) => {
    setDebugMode(m);
  };

  /** Ctrl+Enter 快捷提问（仅调试 · 问答 · 单条页） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter" && module === "debug" && debugSub === "single") {
        void submitAsk();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [module, debugSub, question, debugMode, chatSession]);

  /** 决定是否使用问答页布局 / 召回度双栏布局 */
  const showAskLayout = module === "debug" && debugSub === "single";
  const showRecallLayout = module === "debug" && debugSub === "recall";
  const hasActiveChat = chatSession.turns.length > 0;
  const showSessionsSidebar = chatSession.sessions.length > 0 || hasActiveChat;
  const showSessionsPanel = showSessionsSidebar && !sessionsCollapsed;
  const showSessionsExpand = showSessionsSidebar && sessionsCollapsed;

  /**
   * 切换一级/二级模块
   * - 进入调试页时重置右侧面板 Tab 为「提问」
   * - manage 未传 sub 时默认「问题管理」
   */
  const switchModule = (m: ModuleName, sub?: DebugSub | ManageSub) => {
    setModule(m);
    if (m === "debug" && sub) setDebugSub(sub as DebugSub);
    if (m === "manage") setManageSub((sub as ManageSub) || "items");
  };

  function buildNavGroups(turns: AskChatTurn[]): AnswerNavGroup[] {
    return turns.flatMap((t) => {
      const qLabel = t.question.length > 22 ? `${t.question.slice(0, 22)}…` : t.question;
      if (t.mode === "llm" && t.answers.length > 0) {
        return [{
          turnId: t.id,
          question: qLabel,
          items: t.answers.map((a, i) => ({
            id: a.id,
            label: a.question?.slice(0, 24) || "",
            cardId: `debugAnswerCard-${t.id}-${i}`,
          })),
        }];
      }
      if (t.mode === "rag") {
        const sources = t.searchResults.length ? t.searchResults : (t.chatResult?.sources || []);
        if (!sources.length) return [];
        return [{
          turnId: t.id,
          question: qLabel,
          items: sources.map((s, i) => ({
            id: s.id,
            label: s.question?.slice(0, 24) || "",
            cardId: `ragAnswer-${t.id}-${i}`,
          })),
        }];
      }
      return [];
    });
  }

  const navGroups = buildNavGroups(chatSession.turns);
  const hasNav = navGroups.some((g) => g.items.length > 0);

  const askLayoutClass = [
    "askPageLayout",
    "ui-fade-in",
    hasActiveChat ? "askPageLayout--active" : "askPageLayout--hero",
    showSessionsPanel ? "hasHistory" : "",
    showSessionsExpand ? "hasHistoryExpand historyCollapsed" : "",
    hasNav ? "hasNav" : "",
  ].filter(Boolean).join(" ");

  const renderAskComposer = (opts: {
    loading: boolean;
    variant: "hero" | "compact";
    kbIds: string[];
    kbMap: Record<string, { name?: string }>;
    kbValue: string;
    onKbChange: (id: string) => void;
    onRandom?: () => void;
    extraActions?: ReactNode;
    indexKbId?: string;
  }) => (
    <AskComposer
      question={question}
      onQuestionChange={setQuestion}
      onSubmit={() => void submitAsk()}
      onClear={resetAskSession}
      onRandom={opts.onRandom}
      loading={opts.loading}
      mode={debugMode}
      onModeChange={switchDebugMode}
      kbIds={opts.kbIds}
      kbMap={opts.kbMap}
      kbValue={opts.kbValue}
      onKbChange={opts.onKbChange}
      profiles={profiles}
      profileValue={effectiveProfile}
      onProfileChange={setDebugProfile}
      topK={debugTopK}
      onTopKChange={setDebugTopK}
      indexKbId={opts.indexKbId}
      extraActions={opts.extraActions}
      variant={opts.variant}
    />
  );

  return (
    <div className="appShell">
      {/* ── 左侧全局导航 ── */}
      <aside className="sidebar">
        <div className="sidebarBrand">知识问答控制台</div>
        <nav className="sidebarNav" id="sidebarNav">
          {/* 调试：可折叠，含「问答」「召回度测试」子项 */}
          <div className={`navGroup${debugNavCollapsed ? " collapsed" : ""}`} data-nav-group="debug">
            <button type="button" className={`navGroupHead ${module === "debug" ? "active" : ""}`} data-nav="debug" onClick={() => { setDebugNavCollapsed((c) => !c); switchModule("debug", debugSub); }}>
              <span>调试</span><span className="navChevron">▾</span>
            </button>
            <div className="navSub">
              <button type="button" className={`navItem ${module === "debug" && debugSub === "single" ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); switchModule("debug", "single"); }}>问答</button>
              <button type="button" className={`navItem ${module === "debug" && debugSub === "recall" ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); switchModule("debug", "recall"); }}>召回度测试</button>
              {/* ↑ 点击后 debugSub="recall"，渲染 RecallModule（DebugRecallView.tsx） */}
            </div>
          </div>
          <div className="navGroup" data-nav-group="manage">
            {/* 管理模块：默认子页「问题管理」；文件管理见 ManageFilesView */}
            <button type="button" className={`navGroupHead ${module === "manage" ? "active" : ""}`} onClick={() => switchModule("manage", manageSub)}><span>管理</span></button>
          </div>
          <div className="navGroup" data-nav-group="logs">
            <button type="button" className={`navGroupHead ${module === "logs" ? "active" : ""}`} onClick={() => switchModule("logs")}><span>日志</span></button>
          </div>
          <div className="navGroup" data-nav-group="settings">
            <button type="button" className={`navGroupHead ${module === "settings" ? "active" : ""}`} onClick={() => switchModule("settings")}><span>设置</span></button>
          </div>
        </nav>
      </aside>

      {/* ── 顶栏：面包屑 + 手册 + 后端连接状态 ── */}
      <header className="appHeader">
        <Breadcrumb module={module} debugSub={debugSub} manageSub={manageSub} />
        <div className="headerRight">
          <button type="button" className="headerDocBtn" onClick={() => setDocsOpen(true)}>使用手册</button>
          <div className="status">
            <span className={`dot ${health ? "ok" : "err"}`} />
            <span className="txt">{health ? "已连接" : health === undefined ? "连接中…" : "连接失败"}</span>
          </div>
        </div>
      </header>

      <div className={`appBody${showAskLayout ? " withAskLayout" : ""}${showRecallLayout ? " withLeft" : ""}`} id="appBody">
        {/* ════════════════════════════════════════════════════════════
            调试 · 问答（single）：初始居中输入 → 回答后底部输入 + 右侧导航
            ════════════════════════════════════════════════════════════ */}
        {module === "debug" && debugSub === "single" && (
          <div className="mainContent askPageRoot">
            <div className={askLayoutClass}>
              {showSessionsPanel && (
                <AskSessionsPanel
                  sessions={chatSession.sessions}
                  activeSessionId={chatSession.activeSessionId}
                  onSelect={selectSession}
                  onNewChat={resetAskSession}
                  onCollapse={() => setSessionsCollapsed(true)}
                />
              )}
              {showSessionsExpand && (
                <AskSessionsExpandBtn onExpand={() => setSessionsCollapsed(false)} />
              )}
              {!hasActiveChat ? (
                <div className="askWelcome ui-fade-in">
                  <h1 className="askHeroTitle">知识问答系统</h1>
                  {renderAskComposer({
                    loading: chatSession.loading,
                    variant: "hero",
                    kbIds: debugMode === "llm" ? kbIds : ragKbIds,
                    kbMap: debugMode === "llm" ? kbMap : ragKbMap,
                    kbValue: debugMode === "llm" ? (debugKb || kbIds[0] || "") : (debugRagKb || ragKbIds[0] || ""),
                    onKbChange: debugMode === "llm" ? setDebugKb : setDebugRagKb,
                    onRandom: debugMode === "llm" ? () => { void debugQuestions.load().then(() => setQuestion(debugQuestions.randomQuestion())); } : undefined,
                    indexKbId: debugMode === "rag" ? effectiveKb : undefined,
                    extraActions: debugMode === "rag" ? (
                      <button type="button" className="btn btnXs ghost" disabled={chatSession.loading} onClick={() => void submitSearch()}>
                        {chatSession.loading ? "检索中…" : "检索"}
                      </button>
                    ) : undefined,
                  })}
                </div>
              ) : (
                <>
                  <div className="askChatMain">
                    <div className="askChatScroll scrollInner" ref={chatScrollRef}>
                      <AskChatThread turns={chatSession.turns} activeCardId={activeCardId} />
                    </div>
                    <div className="askComposerWrap ui-fade-in-up">
                      {renderAskComposer({
                        loading: chatSession.loading,
                        variant: "compact",
                        kbIds: debugMode === "llm" ? kbIds : ragKbIds,
                        kbMap: debugMode === "llm" ? kbMap : ragKbMap,
                        kbValue: debugMode === "llm" ? (debugKb || kbIds[0] || "") : (debugRagKb || ragKbIds[0] || ""),
                        onKbChange: debugMode === "llm" ? setDebugKb : setDebugRagKb,
                        onRandom: debugMode === "llm" ? () => { void debugQuestions.load().then(() => setQuestion(debugQuestions.randomQuestion())); } : undefined,
                        indexKbId: debugMode === "rag" ? effectiveKb : undefined,
                        extraActions: debugMode === "rag" ? (
                          <button type="button" className="btn btnXs ghost" disabled={chatSession.loading} onClick={() => void submitSearch()}>
                            {chatSession.loading ? "检索中…" : "检索"}
                          </button>
                        ) : undefined,
                      })}
                    </div>
                  </div>
                  {hasNav && (
                    <GroupedAnswerNavPanel
                      title="候选条目"
                      groups={navGroups}
                      activeCardId={activeCardId}
                      emptyText="提问后显示"
                      onSelect={(cardId) => {
                        setActiveCardId(cardId);
                        scrollToCard(cardId);
                      }}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 调试 · 召回度测试：独立模块，内部自管 LLM/RAG 子状态 */}
        {module === "debug" && debugSub === "recall" && <RecallModule />}

        {/* 管理 / 日志 / 设置：单栏全宽主内容 */}
        {(module === "manage" || module === "logs" || module === "settings") && (
          <div key={module} className="mainContent ui-fade-in">
            {module === "manage" && <ManageView sub={manageSub} onSubChange={setManageSub} />}
            {module === "logs" && <LogsView />}
            {module === "settings" && <SettingsView />}
          </div>
        )}

        <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} />
      </div>

      {/* 全局浮层：确认对话框、Toast 通知 */}
      <ModalOverlay />
      <ToastContainer />
    </div>
  );
}

/** React Query 客户端：缓存 /health、知识库列表等 GET 请求，减少重复拉取 */
const queryClient = new QueryClient();

/**
 * 根组件：挂载 Provider 树
 * QueryClientProvider → AppUiProvider（Toast/Modal）→ AppShell
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppUiProvider>
        <AppShell />
      </AppUiProvider>
    </QueryClientProvider>
  );
}
