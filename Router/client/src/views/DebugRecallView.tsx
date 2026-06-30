import { useCallback, useEffect, useMemo, useState } from "react";
import type { AskTimings, CandidateAnswer, RecallTestRow } from "../types";
import {
  apiJson,
  DEBUG_ASK_TIMEOUT_S,
  fmtMs,
  fmtConfidence,
  isAskTimeoutError,
  isRecallLabeled,
  streamAskConfidence,
  sumTokenUsage,
} from "../api/client";
import { TimingsPanel, TokenPanel, TimeoutMetrics } from "../components/MetricsPanels";
import { Dropdown } from "../components/Dropdown";
import { useAppUi } from "../context/AppUiContext";
import { useKnowledgeBases, useMatchProfiles } from "../hooks/useKnowledgeBases";
import { RecallAnswerModalContent } from "./DebugViews";
import { ModeBar } from "../components/ModeBar";
import { IndexStatusPill } from "../components/IndexStatusPill";
import { RagEvalModal } from "../components/RagEvalModal";
import type { AskMode, RagSearchResult } from "../types";

type RecallRow = RecallTestRow & {
  answers?: CandidateAnswer[];
  timings?: AskTimings;
  candidates?: CandidateAnswer[];
  rag_sources?: RagSearchResult[];
  expected_id?: string;
};

function newRecallRow(partial: Partial<RecallRow> = {}): RecallRow {
  return {
    id: partial.id || `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    question: partial.question || "",
    recalled: partial.recalled ?? "",
    answers: partial.answers || [],
    candidates: partial.candidates || [],
    timings: partial.timings || undefined,
    run_at: partial.run_at,
    notes: partial.notes,
    match_profile_id: partial.match_profile_id,
    model_label: partial.model_label,
  };
}

function aggregateRecallMetrics(rows: RecallRow[]): AskTimings | null {
  const ran = rows.filter((r) => r.timings?.total_ms != null);
  if (!ran.length) return null;
  const totals: AskTimings = {
    total_ms: 0, prepare_ms: 0, match_ms: 0, match_first_token_ms: 0, lookup_ms: 0,
    tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    token_breakdown: [],
  };
  ran.forEach((row, i) => {
    const t = row.timings!;
    totals.total_ms! += Number(t.total_ms) || 0;
    totals.prepare_ms! += Number(t.prepare_ms) || 0;
    totals.match_ms! += Number(t.match_ms) || 0;
    totals.match_first_token_ms! += Number(t.match_first_token_ms) || 0;
    totals.lookup_ms! += Number(t.lookup_ms) || 0;
    totals.tokens = sumTokenUsage(totals.tokens, t.tokens);
    totals.token_breakdown!.push({ phase: `#${i + 1}`, usage: t.tokens || {} });
  });
  return totals;
}

function buildRecallStat(rows: RecallRow[]): string {
  const labeled = rows.filter((r) => r.recalled === "yes" || r.recalled === "no");
  const yes = rows.filter((r) => r.recalled === "yes").length;
  const rate = labeled.length ? `${((yes / labeled.length) * 100).toFixed(1)}%` : "—";
  const withTimings = rows.filter((r) => r.timings?.total_ms != null);
  const avgTotalMs = withTimings.length ? withTimings.reduce((s, r) => s + Number(r.timings!.total_ms), 0) / withTimings.length : null;
  const tokenRows = withTimings.map((r) => Number(r.timings?.tokens?.total_tokens || 0)).filter((n) => n > 0);
  const avgTokens = tokenRows.length ? Math.round(tokenRows.reduce((a, b) => a + b, 0) / tokenRows.length) : null;
  return `共 ${rows.length} 条 · 已标注 ${labeled.length} · 召回率 ${rate} · 平均耗时 ${avgTotalMs != null ? fmtMs(avgTotalMs) : "—"} · 平均 Token ${avgTokens != null ? avgTokens : "—"}`;
}

export function RecallModule() {
  const { showToast, showModal } = useAppUi();
  const { kbMap, kbDisplayName } = useKnowledgeBases();
  const { data: profilesData } = useMatchProfiles();
  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));
  const [kbId, setKbId] = useState("");
  const [topK, setTopK] = useState(5);
  const [profileId, setProfileId] = useState("");
  const [rows, setRows] = useState<RecallRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(() => {
    const stored = localStorage.getItem("recallPageSize");
    if (stored === "0") return 0;
    const n = parseInt(stored || "10", 10);
    return [10, 20, 50, 0].includes(n) ? n : 10;
  });
  const [running, setRunning] = useState(false);
  const [recallMode, setRecallMode] = useState<AskMode>("llm");
  const [rightTab, setRightTab] = useState("ask");
  const [batchMetrics, setBatchMetrics] = useState<AskTimings | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const effectiveKb = kbId || kbIds[0] || "";
  const profiles = profilesData?.profiles || [];
  const effectiveProfile = profileId || profilesData?.default_id || profiles[0]?.id || "";
  const profileLabel = profiles.find((p) => p.id === effectiveProfile)?.name || effectiveProfile;

  const loadTests = useCallback(async (kid: string) => {
    if (!kid) { setRows([]); return; }
    try {
      const path = recallMode === "rag"
        ? `/rag/knowledge-bases/${encodeURIComponent(kid)}/recall-tests`
        : `/knowledge-bases/${encodeURIComponent(kid)}/recall-tests`;
      const doc = await apiJson<{ items: RecallRow[] }>(path);
      setRows((doc.items || []).map((r) => newRecallRow(r)));
    } catch {
      setRows([]);
    }
    setSelected(new Set());
  }, [recallMode]);

  useEffect(() => { if (effectiveKb) void loadTests(effectiveKb); }, [effectiveKb, loadTests]);

  const pageClass = pageSize === 0 ? "size-all" : pageSize === 20 ? "size-20" : pageSize === 50 ? "size-50" : "size-10";
  const statText = useMemo(() => buildRecallStat(rows), [rows]);

  const updateRow = (id: string, patch: Partial<RecallRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const runRow = async (row: RecallRow): Promise<RecallRow> => {
    const q = (row.question || "").trim();
    if (!q || !effectiveKb) return row;
    if (recallMode === "rag") {
      const data = await apiJson<{ results: RagSearchResult[]; timing?: AskTimings }>("/rag/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, kb_id: effectiveKb, top_k: topK }),
      });
      const sources = data.results || [];
      const topId = sources[0]?.id || "";
      const recalled = row.expected_id ? (topId === row.expected_id ? "yes" : "no") : "";
      const updated: RecallRow = {
        ...row,
        run_at: new Date().toISOString(),
        rag_sources: sources,
        timings: data.timing,
        last_top_id: topId,
        recalled: recalled || row.recalled,
        model_label: "RAG",
      };
      setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)));
      return updated;
    }
    let doneData: { answers?: CandidateAnswer[]; timings?: AskTimings; match?: { candidates?: CandidateAnswer[] } } | null = null;
    await streamAskConfidence({ question: q, kb_id: effectiveKb, top_k: topK, match_profile_id: effectiveProfile }, (evt) => {
      if (evt.event === "done") doneData = evt.data as typeof doneData;
    });
    if (!doneData) return row;
    const updated: RecallRow = {
      ...row,
      run_at: new Date().toISOString(),
      candidates: doneData.match?.candidates || [],
      answers: doneData.answers || [],
      timings: doneData.timings || undefined,
      match_profile_id: effectiveProfile,
      model_label: profileLabel,
    };
    setRows((prev) => prev.map((r) => (r.id === row.id ? updated : r)));
    return updated;
  };

  const batchRun = async () => {
    if (!effectiveKb) return showToast("请选择知识库", "error");
    let targets = rows.filter((r) => selected.has(r.id) && (r.question || "").trim());
    if (!targets.length) targets = rows.filter((r) => (r.question || "").trim() && !isRecallLabeled(r));
    if (!targets.length) return showToast("无待运行行（已标注的行会跳过）", "error");
    setRunning(true);
    setTimedOut(false);
    const ran: RecallRow[] = [];
    try {
      for (const row of targets) {
        ran.push(await runRow(row));
      }
      showToast(`已运行 ${targets.length} 条`);
      setBatchMetrics(aggregateRecallMetrics(ran));
      setRightTab("timing");
    } catch (e) {
      if (isAskTimeoutError(e)) {
        setTimedOut(true);
        setRightTab("timing");
        showToast(`请求超时（${DEBUG_ASK_TIMEOUT_S}s）`, "error", 3200);
      } else {
        showToast((e as Error).message, "error", 3200);
      }
    } finally {
      setRunning(false);
    }
  };

  const selectAll = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectIndeterminate = rows.some((r) => selected.has(r.id)) && !selectAll;

  const handleRecallAction = (action: string) => {
    if (action === "addRow") setRows([...rows, newRecallRow()]);
    else if (action === "delete") {
      if (!selected.size) return showToast("请先勾选行", "error");
      setRows(rows.filter((r) => !selected.has(r.id)));
      setSelected(new Set());
    } else if (action === "save") {
      const path = recallMode === "rag"
        ? `/rag/knowledge-bases/${encodeURIComponent(effectiveKb)}/recall-tests`
        : `/knowledge-bases/${encodeURIComponent(effectiveKb)}/recall-tests`;
      void apiJson(path, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: rows }),
      }).then(() => showToast("召回测试已保存")).catch((e) => showToast(e.message, "error"));
    } else if (action === "import") {
      showModal(
        "批量导入问题",
        <div>
          <p className="muted">JSON 数组格式，每项含 question 字段{recallMode === "rag" ? "，可选 expected_id 用于自动标注" : ""}：</p>
          <label className="fieldLabel"><textarea id="recallImportJson" rows={10} className="jsonEditor" placeholder={recallMode === "rag" ? '[{"question":"如何使用曝光补偿？","expected_id":"q001"}]' : '[{"question":"如何使用曝光补偿？"}]'} /></label>
        </div>,
        async () => {
          const raw = (document.getElementById("recallImportJson") as HTMLTextAreaElement)?.value.trim();
          let arr = JSON.parse(raw);
          if (!Array.isArray(arr)) {
            if (arr?.items && Array.isArray(arr.items)) arr = arr.items;
            else throw new Error("须为 JSON 数组或 {items:[...]}");
          }
          setRows([...rows, ...arr.map((x: string | { question?: string; expected_id?: string }) => newRecallRow(typeof x === "string" ? { question: x } : x))]);
        },
        true,
      );
    } else if (action === "sampleFromFaq" && recallMode === "rag") {
      void apiJson<{ items: { id: string; question: string; variants?: string[] }[] }>(
        `/rag/knowledge-bases/${encodeURIComponent(effectiveKb)}/questions`,
      ).then((doc) => {
        const items = (doc.items || []).filter((it) => it.question?.trim());
        if (!items.length) return showToast("RAG FAQ 为空", "error");
        const sampled = items.sort(() => Math.random() - 0.5).slice(0, Math.min(10, items.length));
        setRows([...rows, ...sampled.map((it) => newRecallRow({ question: it.question, expected_id: it.id }))]);
        showToast(`已从 RAG FAQ 采样 ${sampled.length} 条`);
      }).catch((e) => showToast(e.message, "error"));
    } else if (action === "runEval" && recallMode === "rag") {
      showModal("Recall@K 批量评测", <RagEvalModal kbId={effectiveKb} topK={topK} />, async () => {}, true);
    } else if (action === "export") {
      const labeled = rows.filter((r) => r.recalled === "yes" || r.recalled === "no");
      const yes = rows.filter((r) => r.recalled === "yes").length;
      const recallRate = labeled.length ? `${((yes / labeled.length) * 100).toFixed(1)}% (${yes}/${labeled.length})` : "—";
      const modeLabel = recallMode === "rag" ? "RAG" : profileLabel;
      let md = `# 召回度测试报告\n\n- 知识库：${kbDisplayName(effectiveKb)} (${effectiveKb})\n- 模式：${modeLabel}\n- Top K：${topK}\n\n## 汇总\n\n| 指标 | 值 |\n|------|-----|\n| 召回率 | ${recallRate} |\n\n## 明细\n\n`;
      rows.forEach((row, i) => {
        const top = recallMode === "rag" ? row.rag_sources?.[0] : row.answers?.[0];
        const topId = recallMode === "rag" ? top?.id : top?.id;
        const score = recallMode === "rag"
          ? (top as RagSearchResult | undefined)?.rerank_score ?? (top as RagSearchResult | undefined)?.rrf_score
          : top?.confidence;
        const recalled = row.recalled === "yes" ? "是" : row.recalled === "no" ? "否" : "未标注";
        md += `${i + 1}. ${row.question} — ${recalled} — ${topId || "—"} (${score != null ? (recallMode === "rag" ? Number(score).toFixed(3) : fmtConfidence(score as number)) : "—"})\n`;
      });
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `recall_report_${effectiveKb || "kb"}_${Date.now()}.md`;
      a.click();
    }
  };

  return (
    <>
      <aside className="leftPanel visible" id="rightPanel">
        <ModeBar mode={recallMode} onChange={(m) => { setRecallMode(m); setRows([]); }} />
        <div className="stripHead rightTabHead">
          <div className="rightTabs" id="rightTabs">
            <button type="button" className={`tabBtn ${rightTab === "ask" ? "active" : ""}`} data-right-tab="ask" onClick={() => setRightTab("ask")}>操作</button>
            <button type="button" className={`tabBtn ${rightTab === "timing" ? "active" : ""}`} data-right-tab="timing" onClick={() => setRightTab("timing")}>消耗时间</button>
            <button type="button" className={`tabBtn ${rightTab === "tokens" ? "active" : ""}`} data-right-tab="tokens" onClick={() => setRightTab("tokens")}>消耗 Token</button>
          </div>
        </div>
        <div className="rightTabBody">
          <div id="rightTabAsk" className={`rightTabPane ${rightTab === "ask" ? "active" : ""}`}>
            <div className="moduleSide recall stripBody qBody">
              <label className="kbSelectLabel">知识库<select id="recallKbSelect" className="kbSelect" value={effectiveKb} onChange={(e) => setKbId(e.target.value)}>{kbIds.map((id) => <option key={id} value={id}>{kbMap[id]?.name || id}</option>)}</select></label>
              <label className="kbSelectLabel">Top K<input id="recallTopK" type="number" className="topKInput" min={1} max={20} value={topK} onChange={(e) => setTopK(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 5)))} /></label>
              {recallMode === "llm" && (
                <label className="kbSelectLabel">回答模型<select id="recallMatchProfileSelect" className="kbSelect" value={effectiveProfile} onChange={(e) => setProfileId(e.target.value)}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></label>
              )}
              {recallMode === "rag" && <IndexStatusPill kbId={effectiveKb} onRebuild={() => void loadTests(effectiveKb)} />}
              <div className="qActions recallSideActions">
                <button id="recallRunBtn" type="button" className="btn btnXs primary" disabled={running} onClick={() => void batchRun()}>{running ? "运行中…" : "批量运行"}</button>
              </div>
            </div>
          </div>
          <div id="rightTabTiming" className={`rightTabPane ${rightTab === "timing" ? "active" : ""}`}>
            <div className="moduleMetrics recall">
              <div id="recallTimingPanel" className="timingPanel">
                {timedOut ? <TimeoutMetrics /> : <TimingsPanel timings={batchMetrics} emptyText="运行后显示" />}
              </div>
            </div>
          </div>
          <div id="rightTabTokens" className={`rightTabPane ${rightTab === "tokens" ? "active" : ""}`}>
            <div className="moduleMetrics recall">
              <div id="recallTokenPanel" className="tokenPanel">
                {timedOut ? <TimeoutMetrics /> : <TokenPanel timings={batchMetrics} emptyText="运行后显示" />}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div className="mainContent">
        <section id="viewDebugRecall" className="viewPane active">
          <div className="recallPage panel">
            <div className="stripHead">
              <span>召回度测试</span>
              <span id="recallStat" className="recallStat muted">{statText}</span>
            </div>
            <ModeBar mode={recallMode} onChange={(m) => { setRecallMode(m); setRows([]); }} />
            <div className="recallToolbar">
              <label className="recallPageSizeLabel">
                显示条数
                <select id="recallPageSizeSelect" className="recallPageSizeSelect" value={pageSize} onChange={(e) => { const v = parseInt(e.target.value, 10); setPageSize(v); localStorage.setItem("recallPageSize", String(v)); }}>
                  <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={0}>不限</option>
                </select>
              </label>
              <label className="recallSelectAllLabel">
                <input type="checkbox" id="recallSelectAll" checked={selectAll} ref={(el) => { if (el) el.indeterminate = selectIndeterminate; }} onChange={(e) => {
                  if (e.target.checked) setSelected(new Set(rows.map((r) => r.id)));
                  else setSelected(new Set());
                }} /> 全选
              </label>
              <span className="recallToolbarActions">
                <Dropdown label="操作">
                  <button type="button" className="dropdownItem" data-recall-action="addRow" onClick={() => handleRecallAction("addRow")}>+ 添加问题</button>
                  <button type="button" className="dropdownItem" data-recall-action="delete" onClick={() => handleRecallAction("delete")}>删除选中</button>
                  <div className="dropdownDivider" />
                  <button type="button" className="dropdownItem" data-recall-action="save" onClick={() => handleRecallAction("save")}>保存</button>
                  {recallMode === "llm" && (
                    <>
                      <div className="dropdownDivider" />
                      <button type="button" className="dropdownItem" data-recall-action="import" onClick={() => handleRecallAction("import")}>批量导入问题</button>
                    </>
                  )}
                  {recallMode === "rag" && (
                    <>
                      <div className="dropdownDivider" />
                      <button type="button" className="dropdownItem" onClick={() => handleRecallAction("import")}>批量导入问题</button>
                      <button type="button" className="dropdownItem" onClick={() => handleRecallAction("sampleFromFaq")}>从 RAG FAQ 采样</button>
                      <button type="button" className="dropdownItem" onClick={() => handleRecallAction("runEval")}>运行 Recall@K 评测</button>
                    </>
                  )}
                  <button type="button" className="dropdownItem" data-recall-action="export" onClick={() => handleRecallAction("export")}>导出 Markdown</button>
                </Dropdown>
              </span>
            </div>
            <div id="recallListScroll" className={`recallListScroll ${pageClass}`}>
              <div id="recallListBody" className="recallListBody">
                {rows.map((row, idx) => (
                  <div key={row.id} className={`recallCard ${row.recalled === "yes" ? "recalled-yes" : row.recalled === "no" ? "recalled-no" : ""}`} data-row-id={row.id}>
                    <div className="recallCardRow">
                      <label className="recallCheckWrap">
                        <input type="checkbox" className="recallRowCheck" data-id={row.id} checked={selected.has(row.id)} onChange={(e) => {
                          const s = new Set(selected);
                          if (e.target.checked) s.add(row.id); else s.delete(row.id);
                          setSelected(s);
                        }} />
                        <span className="recallSerial">{idx + 1}</span>
                      </label>
                      <div className="recallField recallFieldQ">
                        <span className="recallFieldLabel">问题</span>
                        <textarea className="recallQ" data-id={row.id} rows={1} placeholder="输入人工问题…" value={row.question} onChange={(e) => updateRow(row.id, { question: e.target.value })} />
                      </div>
                      <div className="recallField recallFieldView">
                        <span className="recallFieldLabel">{recallMode === "rag" ? "检索结果" : "模型回答"}</span>
                        <button type="button" className="btn btnXs recallViewBtn" data-id={row.id} disabled={recallMode === "rag" ? !row.rag_sources?.length : !row.answers?.length} onClick={() => {
                          if (recallMode === "rag") {
                            if (!row.rag_sources?.length) return showToast("请先运行该行", "error");
                            showModal("RAG 检索来源", (
                              <div className="ragSourceList">
                                {row.rag_sources.map((s, i) => (
                                  <div key={i} className="confidenceCard ragSourceCard">
                                    <div className="confidenceCardHead">
                                      <span className="pill">{s.id}</span>
                                      {s.rerank_score != null && <span className="pill muted">rerank {Number(s.rerank_score).toFixed(3)}</span>}
                                    </div>
                                    <p className="muted">{s.question}</p>
                                  </div>
                                ))}
                              </div>
                            ), async () => {}, true);
                            return;
                          }
                          if (!row.answers?.length) return showToast("请先运行该行", "error");
                          showModal("置信度回答", <RecallAnswerModalContent answers={row.answers} kbId={effectiveKb} question={row.question} />, async () => {}, true);
                        }}>查看</button>
                      </div>
                      <div className="recallField recallFieldRecall">
                        <span className="recallFieldLabel">是否召回</span>
                        <select className="recallLabel" data-id={row.id} value={row.recalled || ""} onChange={(e) => updateRow(row.id, { recalled: (e.target.value || "") as RecallTestRow["recalled"] })}>
                          <option value="">未标注</option><option value="yes">是</option><option value="no">否</option>
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div id="recallListInfo" className="recallListInfo muted">{rows.length > 0 ? `共 ${rows.length} 条` : "暂无数据"}</div>
          </div>
        </section>
      </div>
    </>
  );
}
