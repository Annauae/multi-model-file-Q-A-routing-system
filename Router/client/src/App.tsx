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

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppUiProvider, ModalOverlay, ToastContainer } from "./context/AppUiContext";
import { useHealth, useKnowledgeBases, useMatchProfiles, useRagKnowledgeBases } from "./hooks/useKnowledgeBases";
import { DocsModal } from "./components/DocsModal";
import { ModeBar } from "./components/ModeBar";
import { IndexStatusPill } from "./components/IndexStatusPill";
import { CandidatesPanel, DebugAnswersPanel, useDebugAsk, useDebugQuestions } from "./views/DebugViews";
import { RagQaMain, RagTimingsPanel, RagTokenPanel, useRagAsk } from "./views/RagDebugViews";
import { TimingsPanel, TokenPanel } from "./components/MetricsPanels";
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
  const [rightTab, setRightTab] = useState("ask"); // 调试页右侧面板当前 Tab （提问、候选匹配、消耗时间、消耗 Token）
  const [docsOpen, setDocsOpen] = useState(false); // 使用手册弹窗是否打开
  const [debugNavCollapsed, setDebugNavCollapsed] = useState(false); // 侧边栏「调试」分组折叠
  const [debugMode, setDebugMode] = useState<AskMode>("llm"); // 问答模式：LLM 匹配 | RAG 检索

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

  // 问答 Hook：仅在对应模式下传入 effectiveKb，另一模式保留各自 kb 避免切换时丢失选择
  const debugAsk = useDebugAsk(debugMode === "llm" ? effectiveKb : (debugKb || kbIds[0] || ""), effectiveProfile, debugTopK); // 调用LLM问答Hook，传入有效知识库ID和问答模型ID，Top K，返回问答结果
  const ragAsk = useRagAsk(debugMode === "rag" ? effectiveKb : (debugRagKb || ragKbIds[0] || ""), debugTopK); // 调用RAG问答Hook，传入有效知识库ID，Top K，返回问答结果
  const debugQuestions = useDebugQuestions(debugKb || kbIds[0] || ""); // 「随机问题」从 LLM 库抽样

  /** Ctrl+Enter 快捷提问（仅调试 · 问答 · 单条页） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter" && module === "debug" && debugSub === "single") {
        if (debugMode === "llm") void debugAsk.ask(question);
        else void ragAsk.chat(question);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [module, debugSub, question, debugAsk, ragAsk, debugMode]);

  /** 决定是否双栏布局（是否在调试页） */
  const showLeft = module === "debug";

  /**
   * 切换一级/二级模块
   * - 进入调试页时重置右侧面板 Tab 为「提问」
   * - manage 未传 sub 时默认「问题管理」
   */
  const switchModule = (m: ModuleName, sub?: DebugSub | ManageSub) => {
    setModule(m);
    if (m === "debug" && sub) setDebugSub(sub as DebugSub);
    if (m === "manage") setManageSub((sub as ManageSub) || "items");
    if (m === "debug") setRightTab("ask");
  };

  // LLM 模式多「候选匹配」Tab；RAG 无候选列表（结果在主区展示）
  const llmTabs = ["ask", "candidates", "timing", "tokens"] as const;
  const ragTabs = ["ask", "timing", "tokens"] as const;
  const tabs = debugMode === "llm" ? llmTabs : ragTabs;

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

      <div className={`appBody ${showLeft ? "withLeft" : ""}`} id="appBody">
        {/* ════════════════════════════════════════════════════════════
            调试 · 问答（single）：双栏 — 左侧提问/指标，右侧结果展示
            ════════════════════════════════════════════════════════════ */}
        {module === "debug" && debugSub === "single" && (
          <>
            {/* 左侧配置面板（DOM id 为 rightPanel 是历史命名，实际在布局左侧） */}
            <aside className="leftPanel visible" id="rightPanel">
              {/* LLM / RAG 模式切换；切换时清空两侧问答状态 */}
              <ModeBar mode={debugMode} onChange={(m) => { setDebugMode(m); setRightTab("ask"); debugAsk.reset(); ragAsk.reset(); }} />
              <div className="stripHead rightTabHead">
                <div className="rightTabs">
                  {tabs.map((tab) => (
                    <button key={tab} type="button" className={`tabBtn ${rightTab === tab ? "active" : ""}`} onClick={() => setRightTab(tab)}>
                      {tab === "ask" ? "提问" : tab === "candidates" ? "候选匹配" : tab === "timing" ? "消耗时间" : "消耗 Token"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rightTabBody">
                {/* Tab: 提问 — 问题输入、操作按钮、知识库/模型/TopK 配置 */}
                <div className={`rightTabPane ${rightTab === "ask" ? "active" : ""}`}>
                  <div className="moduleSide debug single stripBody qBody modePanelEnter">
                    <label className="fieldLabel">问题<textarea rows={4} placeholder="输入问题… Ctrl+Enter 提问" value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
                    <div className="qActions qBtnRow">
                      {debugMode === "llm" ? (
                        <>
                      {/* 用户点击「提问」→ useDebugAsk.ask(question) → POST /ask/confidence/stream */}
                          <button className="btn primary btnXs" type="button" disabled={debugAsk.loading} onClick={() => void debugAsk.ask(question)}>{debugAsk.loading ? "提问中…" : "提问"}</button>
                          <button className="btn ghost btnXs" type="button" onClick={() => { setQuestion(""); debugAsk.reset(); }}>清空</button>
                          <button className="btn ghost btnXs" type="button" onClick={() => { void debugQuestions.load().then(() => setQuestion(debugQuestions.randomQuestion())); }}>随机问题</button>
                        </>
                      ) : (
                        <>
                          {/* RAG「问答」→ useRagAsk.chat → POST /rag/chat（检索+直出/合成） */}
                          <button className="btn primary btnXs" type="button" disabled={ragAsk.loading} onClick={() => void ragAsk.chat(question)}>{ragAsk.loading ? "问答中…" : "问答"}</button>
                          {/* RAG「检索」→ useRagAsk.search → POST /rag/search（仅检索，不合成） */}
                          <button className="btn btnXs" type="button" disabled={ragAsk.loading} onClick={() => void ragAsk.search(question)}>{ragAsk.loading ? "检索中…" : "检索"}</button>
                          <button className="btn ghost btnXs" type="button" onClick={() => { setQuestion(""); ragAsk.reset(); }}>清空</button>
                        </>
                      )}
                    </div>
                    <div className="qActions qConfigRow">
                      <label className="kbSelectLabel">知识库<select className="kbSelect" value={debugMode === "rag" ? (debugRagKb || ragKbIds[0] || "") : (debugKb || kbIds[0] || "")} onChange={(e) => { if (debugMode === "rag") setDebugRagKb(e.target.value); else setDebugKb(e.target.value); }}>{(debugMode === "rag" ? ragKbIds : kbIds).map((id) => <option key={id} value={id}>{(debugMode === "rag" ? ragKbMap : kbMap)[id]?.name || id}</option>)}</select></label>
                      {debugMode === "llm" && (
                        <label className="kbSelectLabel">问答模型<select className="kbSelect" value={effectiveProfile} onChange={(e) => setDebugProfile(e.target.value)}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></label>
                      )}
                      <label className="kbSelectLabel">Top K<input type="number" className="topKInput" min={1} max={20} value={debugTopK} onChange={(e) => setDebugTopK(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 5)))} /></label>
                      {/* RAG 模式下显示 Weaviate 索引是否就绪 */}
                      {debugMode === "rag" && <IndexStatusPill kbId={effectiveKb} />}
                    </div>
                  </div>
                </div>

                {/* Tab: 候选匹配 / Token — 仅 LLM 模式 */}
                {debugMode === "llm" && (
                  <>
                    <div className={`rightTabPane ${rightTab === "candidates" ? "active" : ""}`}>
                      <div className="routeScroll"><div className="routeBody"><CandidatesPanel candidates={debugAsk.candidates} onSelect={(i) => document.getElementById(`debugAnswerCard-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" })} /></div></div>
                    </div>
                    <div className={`rightTabPane ${rightTab === "tokens" ? "active" : ""}`}>
                      <div className="moduleMetrics ask"><div className="tokenPanel"><TokenPanel timings={debugAsk.timings} emptyText="提问后显示" /></div></div>
                    </div>
                  </>
                )}

                {/* Tab: 消耗时间 — LLM 与 RAG 共用 Tab，内容按模式分支 */}
                <div className={`rightTabPane ${rightTab === "timing" ? "active" : ""}`}>
                  <div className="moduleMetrics ask">
                    {debugMode === "llm"
                      ? <div className="timingPanel"><TimingsPanel timings={debugAsk.timings} emptyText="提问后显示" /></div>
                      : <RagTimingsPanel timing={ragAsk.chatResult?.timing} />}
                  </div>
                </div>

                {/* Tab: Token — 仅 RAG 模式（分 Embedding / Rerank / LLM 阶段） */}
                {debugMode === "rag" && (
                  <div className={`rightTabPane ${rightTab === "tokens" ? "active" : ""}`}>
                    <div className="moduleMetrics ask">
                      <RagTokenPanel chatResult={ragAsk.chatResult} />
                    </div>
                  </div>
                )}
              </div>
            </aside>

            {/* 右侧主内容：LLM 候选回答列表 或 RAG 检索/合成结果 */}
            <div className="mainContent">
              <section className="viewPane active">
                {debugMode === "llm" ? (
                  <div className="panel">
                    <div className="stripHead"><span>候选回答</span></div>
                    <div className="answersScroll"><div className="answersBody"><DebugAnswersPanel kbId={effectiveKb} loading={debugAsk.loading} answers={debugAsk.answers} /></div></div>
                  </div>
                ) : (
                  /* RAG 模式右侧：RagQaMain 展示合成回答与检索来源 */
                  <RagQaMain kbId={effectiveKb} loading={ragAsk.loading} chatResult={ragAsk.chatResult} searchResults={ragAsk.searchResults} activeNav={ragAsk.activeNav} setActiveNav={ragAsk.setActiveNav} lastError={ragAsk.lastError} />
                )}
              </section>
            </div>
          </>
        )}

        {/* 调试 · 召回度测试：独立模块，内部自管 LLM/RAG 子状态 */}
        {module === "debug" && debugSub === "recall" && <RecallModule />}

        {/* 管理 / 日志 / 设置：单栏全宽主内容 */}
        {(module === "manage" || module === "logs" || module === "settings") && (
          <div className="mainContent">
            {module === "manage" && <ManageView sub={manageSub} onSubChange={setManageSub} />}
            {module === "logs" && <LogsView />}
            {module === "settings" && <SettingsView />}
          </div>
        )}
      </div>

      {/* 全局浮层：使用手册弹窗、确认对话框、Toast 通知 */}
      <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} />
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
