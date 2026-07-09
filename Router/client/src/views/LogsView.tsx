import { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../api/client";
import type { LogEntry } from "../types";
import { useKnowledgeBases } from "../hooks/useKnowledgeBases";
import { useAppUi } from "../context/AppUiContext";

const MODULES = ["", "llm", "rag", "manage", "files", "generate", "settings"] as const;
const MODULE_LABELS: Record<string, string> = {
  "": "全部",
  llm: "问答模型",
  rag: "RAG",
  manage: "问题管理",
  files: "文件管理",
  generate: "问题生成",
  settings: "设置",
};

const MODULE_FILTER: Record<string, string> = {
  llm: "debug",
  rag: "rag-debug,rag-manage,rag",
};

function parseLogTs(ts: string): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function formatLogTime(ts: string): string {
  const d = parseLogTs(ts);
  if (!d) return (ts || "").replace("T", " ").replace("Z", "");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatGroupLabel(d: Date): string {
  const today = startOfDay(new Date());
  const day = startOfDay(d);
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
  const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  if (diff === 0) return `今天 · ${dateStr}`;
  if (diff === 1) return `昨天 · ${dateStr}`;
  return dateStr;
}

function renderLogEntry(entry: LogEntry) {
  const kind = (entry as { kind?: string }).kind || entry.action || "log";
  const ts = formatLogTime(entry.ts || "");
  const mod = entry.module ? `[${entry.module}]` : "";
  const action = entry.action && entry.action !== kind ? `[${entry.action}]` : "";
  const kb = entry.kb_id ? ` kb=${entry.kb_id}` : "";
  let detail = entry.detail || "";
  const isRag = (entry.module || "").startsWith("rag");
  const maxLen = isRag ? 4000 : 800;
  if (detail.length > maxLen) detail = `${detail.slice(0, maxLen)}…（已截断）`;
  return (
    <div key={`${entry.ts}-${entry.action}-${detail.slice(0, 40)}`} className={`logBlock ${kind}`}>
      <span className="logLine"><span className="logTime">{ts}</span> {mod}{action}{kb} {detail}</span>
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
  const [timeStart, setTimeStart] = useState(() => toDatetimeLocalValue(startOfDay(new Date())));
  const [timeEnd, setTimeEnd] = useState(() => toDatetimeLocalValue(endOfDay(new Date())));
  const boxRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async (mod = module) => {
    const qs = new URLSearchParams({ limit: "500" });
    const modulesParam = mod ? MODULE_FILTER[mod] ?? mod : "";
    if (modulesParam) qs.set("modules", modulesParam);
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

  const filteredItems = useMemo(() => {
    const start = timeStart ? new Date(timeStart) : null;
    const end = timeEnd ? new Date(timeEnd) : null;
    if (end) end.setSeconds(59, 999);
    return items.filter((entry) => {
      const d = parseLogTs(entry.ts);
      if (!d) return true;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }, [items, timeStart, timeEnd]);

  const groupedLogs = useMemo(() => {
    const groups = new Map<string, { label: string; sortKey: number; entries: LogEntry[] }>();
    for (const entry of filteredItems) {
      const d = parseLogTs(entry.ts);
      const key = d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : "unknown";
      if (!groups.has(key)) {
        groups.set(key, {
          label: d ? formatGroupLabel(d) : "未知日期",
          sortKey: d ? d.getTime() : 0,
          entries: [],
        });
      }
      groups.get(key)!.entries.push(entry);
    }
    return [...groups.values()].sort((a, b) => a.sortKey - b.sortKey);
  }, [filteredItems]);

  const applyPreset = (preset: "today" | "yesterday" | "week") => {
    const now = new Date();
    if (preset === "today") {
      setTimeStart(toDatetimeLocalValue(startOfDay(now)));
      setTimeEnd(toDatetimeLocalValue(endOfDay(now)));
      return;
    }
    if (preset === "yesterday") {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      setTimeStart(toDatetimeLocalValue(startOfDay(y)));
      setTimeEnd(toDatetimeLocalValue(endOfDay(y)));
      return;
    }
    const week = new Date(now);
    week.setDate(week.getDate() - 6);
    setTimeStart(toDatetimeLocalValue(startOfDay(week)));
    setTimeEnd(toDatetimeLocalValue(endOfDay(now)));
  };

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
        <div key={module} className="logsMain ui-fade-in">
          <div className="logsToolbar stripHead">
            <div className="logsToolbarLeft">
              <label className="kbSelectLabel">知识库
                <select id="logsKbSelect" className="kbSelect" value={kbId} onChange={(e) => setKbId(e.target.value)}>
                  <option value="">全部知识库</option>
                  {kbIds.map((id) => <option key={id} value={id}>{kbMap[id]?.name || id}</option>)}
                </select>
              </label>
              <div className="logsTimeRange">
                <label className="logsTimeField">
                  <span>开始</span>
                  <input type="datetime-local" className="logsDatetime" value={timeStart} onChange={(e) => setTimeStart(e.target.value)} />
                </label>
                <span className="logsTimeSep">至</span>
                <label className="logsTimeField">
                  <span>结束</span>
                  <input type="datetime-local" className="logsDatetime" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)} />
                </label>
              </div>
              <div className="logsTimePresets">
                <button type="button" className="btn btnXs ghost" onClick={() => applyPreset("today")}>今天</button>
                <button type="button" className="btn btnXs ghost" onClick={() => applyPreset("yesterday")}>昨天</button>
                <button type="button" className="btn btnXs ghost" onClick={() => applyPreset("week")}>近 7 天</button>
              </div>
            </div>
            <span className="headActions">
              <span className="logsCount muted">{filteredItems.length} 条</span>
              <button id="logsPauseBtn" type="button" className="btn btnXs ghost" onClick={() => setPaused(!paused)}>{paused ? "继续" : "暂停"}</button>
              <button id="logsClearBtn" type="button" className="btn btnXs ghost" onClick={() => {
                if (!confirm("确定清空当前页面显示的日志？（数据库中的日志不会被删除）")) return;
                setItems([]);
                showToast("页面日志已清空");
              }}>清空</button>
              <button id="logsRefreshBtn" type="button" className="btn btnXs primary" onClick={() => void fetchLogs()}>刷新</button>
            </span>
          </div>
          <div className="logScroll logsScrollMain">
            <div id="logsBox" className="logBody logsGroupedBody" ref={boxRef}>
              {groupedLogs.length ? groupedLogs.map((group) => (
                <section key={group.label} className="logsDayGroup">
                  <div className="logsDayHead">{group.label}<span className="muted"> · {group.entries.length} 条</span></div>
                  {group.entries.map(renderLogEntry)}
                </section>
              )) : <div className="empty">暂无日志</div>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
