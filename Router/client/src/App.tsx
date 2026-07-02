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

const MODULE_LABELS: Record<ModuleName, string> = { debug: "调试", manage: "管理", logs: "日志", settings: "设置" };
const SUB_LABELS: Record<DebugSub, string> = { single: "问答", recall: "召回度测试" };
const MANAGE_SUB_LABELS: Record<ManageSub, string> = { items: "问题管理", files: "文件管理" };

function Breadcrumb({ module, debugSub, manageSub }: { module: ModuleName; debugSub: DebugSub; manageSub: ManageSub }) {
  let html = `首页 / <strong>${MODULE_LABELS[module]}</strong>`;
  if (module === "debug") html += ` / ${SUB_LABELS[debugSub]}`;
  if (module === "manage") html += ` / ${MANAGE_SUB_LABELS[manageSub]}`;
  return <div className="breadcrumb" id="breadcrumb" dangerouslySetInnerHTML={{ __html: html }} />;
}

function AppShell() {
  const { data: health } = useHealth();
  const { kbMap } = useKnowledgeBases();
  const { kbMap: ragKbMap } = useRagKnowledgeBases();
  const { data: profilesData } = useMatchProfiles();
  const [module, setModule] = useState<ModuleName>("debug");
  const [debugSub, setDebugSub] = useState<DebugSub>("single");
  const [manageSub, setManageSub] = useState<ManageSub>("items");
  const [rightTab, setRightTab] = useState("ask");
  const [docsOpen, setDocsOpen] = useState(false);
  const [debugNavCollapsed, setDebugNavCollapsed] = useState(false);
  const [debugMode, setDebugMode] = useState<AskMode>("llm");

  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));
  const ragKbIds = Object.keys(ragKbMap).sort((a, b) => Number(a) - Number(b));
  const [debugKb, setDebugKb] = useState("");
  const [debugRagKb, setDebugRagKb] = useState("");
  const [debugProfile, setDebugProfile] = useState("");
  const [debugTopK, setDebugTopK] = useState(5);
  const [question, setQuestion] = useState("");

  const effectiveKb = debugMode === "rag" ? (debugRagKb || ragKbIds[0] || "") : (debugKb || kbIds[0] || "");
  const profiles = profilesData?.profiles || [];
  const effectiveProfile = debugProfile || profilesData?.default_id || profiles[0]?.id || "";

  const debugAsk = useDebugAsk(debugMode === "llm" ? effectiveKb : (debugKb || kbIds[0] || ""), effectiveProfile, debugTopK);
  const ragAsk = useRagAsk(debugMode === "rag" ? effectiveKb : (debugRagKb || ragKbIds[0] || ""), debugTopK);
  const debugQuestions = useDebugQuestions(debugKb || kbIds[0] || "");

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

  const showLeft = module === "debug";

  const switchModule = (m: ModuleName, sub?: DebugSub | ManageSub) => {
    setModule(m);
    if (m === "debug" && sub) setDebugSub(sub as DebugSub);
    if (m === "manage") setManageSub((sub as ManageSub) || "items");
    if (m === "debug") setRightTab("ask");
  };

  const llmTabs = ["ask", "candidates", "timing", "tokens"] as const;
  const ragTabs = ["ask", "timing", "tokens"] as const;
  const tabs = debugMode === "llm" ? llmTabs : ragTabs;

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="sidebarBrand">知识问答控制台</div>
        <nav className="sidebarNav" id="sidebarNav">
          <div className={`navGroup${debugNavCollapsed ? " collapsed" : ""}`} data-nav-group="debug">
            <button type="button" className={`navGroupHead ${module === "debug" ? "active" : ""}`} data-nav="debug" onClick={() => { setDebugNavCollapsed((c) => !c); switchModule("debug", debugSub); }}>
              <span>调试</span><span className="navChevron">▾</span>
            </button>
            <div className="navSub">
              <button type="button" className={`navItem ${module === "debug" && debugSub === "single" ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); switchModule("debug", "single"); }}>问答</button>
              <button type="button" className={`navItem ${module === "debug" && debugSub === "recall" ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); switchModule("debug", "recall"); }}>召回度测试</button>
            </div>
          </div>
          <div className="navGroup" data-nav-group="manage">
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
        {module === "debug" && debugSub === "single" && (
          <>
            <aside className="leftPanel visible" id="rightPanel">
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
                <div className={`rightTabPane ${rightTab === "ask" ? "active" : ""}`}>
                  <div className="moduleSide debug single stripBody qBody modePanelEnter">
                    <label className="fieldLabel">问题<textarea rows={4} placeholder="输入问题… Ctrl+Enter 提问" value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
                    <div className="qActions qBtnRow">
                      {debugMode === "llm" ? (
                        <>
                          <button className="btn primary btnXs" type="button" disabled={debugAsk.loading} onClick={() => void debugAsk.ask(question)}>{debugAsk.loading ? "提问中…" : "提问"}</button>
                          <button className="btn ghost btnXs" type="button" onClick={() => { setQuestion(""); debugAsk.reset(); }}>清空</button>
                          <button className="btn ghost btnXs" type="button" onClick={() => { void debugQuestions.load().then(() => setQuestion(debugQuestions.randomQuestion())); }}>随机问题</button>
                        </>
                      ) : (
                        <>
                          <button className="btn primary btnXs" type="button" disabled={ragAsk.loading} onClick={() => void ragAsk.chat(question)}>{ragAsk.loading ? "问答中…" : "问答"}</button>
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
                      {debugMode === "rag" && <IndexStatusPill kbId={effectiveKb} />}
                    </div>
                  </div>
                </div>
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
                <div className={`rightTabPane ${rightTab === "timing" ? "active" : ""}`}>
                  <div className="moduleMetrics ask">
                    {debugMode === "llm"
                      ? <div className="timingPanel"><TimingsPanel timings={debugAsk.timings} emptyText="提问后显示" /></div>
                      : <RagTimingsPanel timing={ragAsk.chatResult?.timing} />}
                  </div>
                </div>
                {debugMode === "rag" && (
                  <div className={`rightTabPane ${rightTab === "tokens" ? "active" : ""}`}>
                    <div className="moduleMetrics ask">
                      <RagTokenPanel chatResult={ragAsk.chatResult} />
                    </div>
                  </div>
                )}
              </div>
            </aside>
            <div className="mainContent">
              <section className="viewPane active">
                {debugMode === "llm" ? (
                  <div className="panel">
                    <div className="stripHead"><span>候选回答</span></div>
                    <div className="answersScroll"><div className="answersBody"><DebugAnswersPanel kbId={effectiveKb} loading={debugAsk.loading} answers={debugAsk.answers} /></div></div>
                  </div>
                ) : (
                  <RagQaMain kbId={effectiveKb} loading={ragAsk.loading} chatResult={ragAsk.chatResult} searchResults={ragAsk.searchResults} activeNav={ragAsk.activeNav} setActiveNav={ragAsk.setActiveNav} lastError={ragAsk.lastError} />
                )}
              </section>
            </div>
          </>
        )}

        {module === "debug" && debugSub === "recall" && <RecallModule />}

        {(module === "manage" || module === "logs" || module === "settings") && (
          <div className="mainContent">
            {module === "manage" && <ManageView sub={manageSub} onSubChange={setManageSub} />}
            {module === "logs" && <LogsView />}
            {module === "settings" && <SettingsView />}
          </div>
        )}
      </div>

      <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} />
      <ModalOverlay />
      <ToastContainer />
    </div>
  );
}

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppUiProvider>
        <AppShell />
      </AppUiProvider>
    </QueryClientProvider>
  );
}
