import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppUiProvider, ModalOverlay, ToastContainer } from "./context/AppUiContext";
import { useHealth, useKnowledgeBases, useMatchProfiles } from "./hooks/useKnowledgeBases";
import { DocsModal } from "./components/DocsModal";
import { CandidatesPanel, DebugAnswersPanel, useDebugAsk, useDebugQuestions } from "./views/DebugViews";
import { TimingsPanel, TokenPanel } from "./components/MetricsPanels";
import { ManageView } from "./views/ManageView";
import { LogsView } from "./views/LogsView";
import { SettingsView } from "./views/SettingsView";
import { RecallModule } from "./views/DebugRecallView";
import type { DebugSub, ManageSub, ModuleName } from "./types";
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
  const { data: profilesData } = useMatchProfiles();
  const [module, setModule] = useState<ModuleName>("debug");
  const [debugSub, setDebugSub] = useState<DebugSub>("single");
  const [manageSub, setManageSub] = useState<ManageSub>("items");
  const [rightTab, setRightTab] = useState("ask");
  const [docsOpen, setDocsOpen] = useState(false);
  const [debugNavCollapsed, setDebugNavCollapsed] = useState(false);

  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));
  const [debugKb, setDebugKb] = useState("");
  const [debugProfile, setDebugProfile] = useState("");
  const [debugTopK, setDebugTopK] = useState(5);
  const [question, setQuestion] = useState("");

  const effectiveKb = debugKb || kbIds[0] || "";
  const profiles = profilesData?.profiles || [];
  const effectiveProfile = debugProfile || profilesData?.default_id || profiles[0]?.id || "";

  const debugAsk = useDebugAsk(effectiveKb, effectiveProfile, debugTopK);
  const debugQuestions = useDebugQuestions(effectiveKb);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter" && module === "debug" && debugSub === "single") {
        void debugAsk.ask(question);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [module, debugSub, question, debugAsk]);

  const showLeft = module === "debug";

  const switchModule = (m: ModuleName, sub?: DebugSub | ManageSub) => {
    setModule(m);
    if (m === "debug" && sub) setDebugSub(sub as DebugSub);
    if (m === "manage") {
      setManageSub((sub as ManageSub) || "items");
    }
    if (m === "debug") setRightTab("ask");
  };

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="sidebarBrand">知识问答控制台</div>
        <nav className="sidebarNav" id="sidebarNav">
          <div className={`navGroup${debugNavCollapsed ? " collapsed" : ""}`} data-nav-group="debug">
            <button
              type="button"
              className={`navGroupHead ${module === "debug" ? "active" : ""}`}
              data-nav="debug"
              onClick={() => {
                setDebugNavCollapsed((c) => !c);
                switchModule("debug", debugSub);
              }}
            >
              <span>调试</span><span className="navChevron">▾</span>
            </button>
            <div className="navSub">
              <button type="button" className={`navItem ${module === "debug" && debugSub === "single" ? "active" : ""}`} data-module="debug" data-sub="single" onClick={(e) => { e.stopPropagation(); switchModule("debug", "single"); }}>问答</button>
              <button type="button" className={`navItem ${module === "debug" && debugSub === "recall" ? "active" : ""}`} data-module="debug" data-sub="recall" onClick={(e) => { e.stopPropagation(); switchModule("debug", "recall"); }}>召回度测试</button>
            </div>
          </div>
          <div className="navGroup" data-nav-group="manage">
            <button type="button" className={`navGroupHead ${module === "manage" ? "active" : ""}`} data-nav="manage" onClick={() => switchModule("manage", manageSub)}><span>管理</span></button>
          </div>
          <div className="navGroup" data-nav-group="logs">
            <button type="button" className={`navGroupHead ${module === "logs" ? "active" : ""}`} data-nav="logs" onClick={() => switchModule("logs")}><span>日志</span></button>
          </div>
          <div className="navGroup" data-nav-group="settings">
            <button type="button" className={`navGroupHead ${module === "settings" ? "active" : ""}`} data-nav="settings" onClick={() => switchModule("settings")}><span>设置</span></button>
          </div>
        </nav>
      </aside>

      <header className="appHeader">
        <Breadcrumb module={module} debugSub={debugSub} manageSub={manageSub} />
        <div className="headerRight">
          <button type="button" id="docsOpenBtn" className="headerDocBtn" onClick={() => setDocsOpen(true)}>使用手册</button>
          <div className="status">
            <span className={`dot ${health ? "ok" : "err"}`} id="healthDot" />
            <span className="txt" id="healthText">{health ? "已连接" : health === undefined ? "连接中…" : "连接失败"}</span>
          </div>
        </div>
      </header>

      <div className={`appBody ${showLeft ? "withLeft" : ""}`} id="appBody">
        {module === "debug" && debugSub === "single" && (
          <>
            <aside className="leftPanel visible" id="rightPanel">
              <div className="stripHead rightTabHead">
                <div className="rightTabs" id="rightTabs">
                  {(["ask", "candidates", "timing", "tokens"] as const).map((tab) => (
                    <button key={tab} type="button" className={`tabBtn ${rightTab === tab ? "active" : ""}`} data-right-tab={tab} onClick={() => setRightTab(tab)}>
                      {tab === "ask" ? "提问" : tab === "candidates" ? "候选匹配" : tab === "timing" ? "消耗时间" : "消耗 Token"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rightTabBody">
                <div id="rightTabAsk" className={`rightTabPane ${rightTab === "ask" ? "active" : ""}`}>
                  <div className="moduleSide debug single stripBody qBody">
                    <label className="fieldLabel">问题<textarea id="debugQuestion" rows={4} placeholder="输入问题… Ctrl+Enter 提问" value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
                    <div className="qActions qBtnRow">
                      <button id="debugAskBtn" className="btn primary btnXs" type="button" disabled={debugAsk.loading} onClick={() => void debugAsk.ask(question)}>{debugAsk.loading ? "运行中…" : "提问"}</button>
                      <button id="debugClearBtn" className="btn ghost btnXs" type="button" onClick={() => { setQuestion(""); debugAsk.reset(); }}>清空</button>
                      <button id="debugRandomBtn" className="btn ghost btnXs" type="button" onClick={() => { void debugQuestions.load().then(() => setQuestion(debugQuestions.randomQuestion())); }}>随机问题</button>
                    </div>
                    <div className="qActions qConfigRow">
                      <label className="kbSelectLabel">知识库<select id="debugKbSelect" className="kbSelect" value={effectiveKb} onChange={(e) => setDebugKb(e.target.value)}>{kbIds.length ? kbIds.map((id) => <option key={id} value={id}>{kbMap[id]?.name || id}</option>) : <option value="">无知识库</option>}</select></label>
                      <label className="kbSelectLabel">回答模型<select id="debugMatchProfileSelect" className="kbSelect" value={effectiveProfile} onChange={(e) => setDebugProfile(e.target.value)}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></label>
                      <label className="kbSelectLabel">Top K<input id="debugTopK" type="number" className="topKInput" min={1} max={20} value={debugTopK} onChange={(e) => setDebugTopK(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 5)))} /></label>
                    </div>
                  </div>
                </div>
                <div id="rightTabCandidates" className={`rightTabPane ${rightTab === "candidates" ? "active" : ""}`}>
                  <div className="routeScroll"><div id="debugCandidatesBox" className="routeBody"><CandidatesPanel candidates={debugAsk.candidates} onSelect={(i) => document.getElementById(`debugAnswerCard-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" })} /></div></div>
                </div>
                <div id="rightTabTiming" className={`rightTabPane ${rightTab === "timing" ? "active" : ""}`}>
                  <div className="moduleMetrics ask">
                    <div id="askTimingPanel" className="timingPanel"><TimingsPanel timings={debugAsk.timings} emptyText="提问后显示" /></div>
                  </div>
                </div>
                <div id="rightTabTokens" className={`rightTabPane ${rightTab === "tokens" ? "active" : ""}`}>
                  <div className="moduleMetrics ask">
                    <div id="askTokenPanel" className="tokenPanel"><TokenPanel timings={debugAsk.timings} emptyText="提问后显示" /></div>
                  </div>
                </div>
              </div>
            </aside>
            <div className="mainContent">
              <section id="viewDebugSingle" className="viewPane active">
                <div className="panel">
                  <div className="stripHead"><span>候选回答</span></div>
                  <div className="answersScroll"><div id="debugAnswersBox" className="answersBody"><DebugAnswersPanel kbId={effectiveKb} loading={debugAsk.loading} answers={debugAsk.answers} /></div></div>
                </div>
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
