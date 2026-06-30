import { useEffect, useRef, useState } from "react";
import { apiJson } from "../api/client";
import type { LogEntry } from "../types";
import { useKnowledgeBases } from "../hooks/useKnowledgeBases";
import { useAppUi } from "../context/AppUiContext";

const MODULES = ["", "debug", "manage", "files", "generate", "settings"] as const;
const MODULE_LABELS: Record<string, string> = { "": "全部", debug: "调试", manage: "问题管理", files: "文件管理", generate: "问题生成", settings: "设置" };

function renderLogEntry(entry: LogEntry) {
  const kind = (entry as { kind?: string }).kind || entry.action || "log";
  const ts = (entry.ts || "").replace("T", " ").replace("Z", "");
  const mod = entry.module ? `[${entry.module}]` : "";
  const kb = entry.kb_id ? ` kb=${entry.kb_id}` : "";
  let detail = entry.detail || "";
  if (detail.length > 800) detail = `${detail.slice(0, 800)}…（已截断）`;
  return (
    <div key={ts + detail} className={`logBlock ${kind}`}>
      <span className="logLine">{ts} {mod}{kb} {detail}</span>
    </div>
  );
}

export function LogsView() {
  const { showToast } = useAppUi();
  const { kbMap, refresh: refreshKb } = useKnowledgeBases();
  const [module, setModule] = useState("");
  const [kbId, setKbId] = useState("");
  const [paused, setPaused] = useState(false);
  const [items, setItems] = useState<LogEntry[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async (mod = module) => {
    const qs = new URLSearchParams({ limit: "500" });
    if (mod) qs.set("module", mod);
    if (kbId) qs.set("kb_id", kbId);
    try {
      const data = await apiJson<{ items: LogEntry[] }>(`/logs?${qs}`);
      setItems(data.items || []);
      if (!paused && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  };

  useEffect(() => {
    void refreshKb();
    void fetchLogs();
    const t = setInterval(() => { if (!paused) void fetchLogs(); }, 3000);
    return () => clearInterval(t);
  }, [module, kbId, paused]);

  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));

  return (
    <section className="viewPane active" id="viewLogs">
      <div className="logsLayout">
        <nav className="logsSubNav" id="logsSubNav">
          {MODULES.map((m) => (
            <button key={m || "all"} type="button" className={`logsNavItem ${module === m ? "active" : ""}`} data-log-module={m} onClick={() => setModule(m)}>
              {MODULE_LABELS[m]}
            </button>
          ))}
        </nav>
        <div className="logsMain">
          <div className="logsToolbar stripHead">
            <label className="kbSelectLabel">知识库
              <select id="logsKbSelect" className="kbSelect" value={kbId} onChange={(e) => setKbId(e.target.value)}>
                <option value="">全部知识库</option>
                {kbIds.map((id) => <option key={id} value={id}>{kbMap[id]?.name || id}</option>)}
              </select>
            </label>
            <span className="headActions">
              <button id="logsPauseBtn" type="button" className="btn btnXs ghost" onClick={() => setPaused(!paused)}>{paused ? "继续" : "暂停"}</button>
              <button id="logsClearBtn" type="button" className="btn btnXs ghost" onClick={async () => {
                if (!confirm("确定清空全部操作日志？")) return;
                await apiJson("/logs", { method: "DELETE" });
                setItems([]);
                showToast("日志已清空");
              }}>清空</button>
              <button id="logsRefreshBtn" type="button" className="btn btnXs primary" onClick={() => void fetchLogs()}>刷新</button>
            </span>
          </div>
          <div className="logScroll logsScrollMain">
            <div id="logsBox" className="logBody" ref={boxRef}>
              {items.length ? items.map(renderLogEntry) : <div className="empty">暂无日志</div>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
