let recallRows = [];
let recallSelected = new Set();
let recallLastProfileId = "";
let recallPageSize = 10;

function recallKbId() {
  return ($("#recallKbSelect")?.value || "").trim();
}

function recallTopK() {
  const n = parseInt($("#recallTopK")?.value || "5", 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 5;
}

function loadRecallPageSize() {
  const stored = localStorage.getItem("recallPageSize");
  if (stored === "0") return 0;
  const n = parseInt(stored || "10", 10);
  return [10, 20, 50, 0].includes(n) ? n : 10;
}

function recallPageSizeClass(size) {
  if (size === 0) return "size-all";
  if (size === 20) return "size-20";
  if (size === 50) return "size-50";
  return "size-10";
}

function applyRecallPageSize(size = recallPageSize) {
  recallPageSize = size;
  localStorage.setItem("recallPageSize", String(size));
  const scroll = $("#recallListScroll");
  if (scroll) {
    scroll.classList.remove("size-10", "size-20", "size-50", "size-all");
    scroll.classList.add(recallPageSizeClass(size));
  }
  const sel = $("#recallPageSizeSelect");
  if (sel) sel.value = String(size);
}

function newRecallRow(partial = {}) {
  return {
    id: partial.id || `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    question: partial.question || "",
    run_at: partial.run_at || "",
    candidates: partial.candidates || [],
    answers: partial.answers || [],
    recalled: partial.recalled ?? null,
    notes: partial.notes || "",
    match_profile_id: partial.match_profile_id || "",
    model_label: partial.model_label || "",
    timings: partial.timings || null,
  };
}

function updateRecallStat() {
  const el = $("#recallStat");
  if (!el) return;
  const labeled = recallRows.filter((r) => r.recalled === "yes" || r.recalled === "no");
  const yes = recallRows.filter((r) => r.recalled === "yes").length;
  const rate = labeled.length ? `${((yes / labeled.length) * 100).toFixed(1)}%` : "—";

  const withTimings = recallRows.filter((r) => r.timings?.total_ms != null);
  const avgTotalMs = withTimings.length
    ? withTimings.reduce((sum, r) => sum + Number(r.timings.total_ms), 0) / withTimings.length
    : null;
  const tokenRows = withTimings
    .map((r) => Number(r.timings?.tokens?.total_tokens || 0))
    .filter((n) => n > 0);
  const avgTokens = tokenRows.length
    ? Math.round(tokenRows.reduce((a, b) => a + b, 0) / tokenRows.length)
    : null;

  const avgTimeText = avgTotalMs != null ? fmtMs(avgTotalMs) : "—";
  const avgTokenText = avgTokens != null ? String(avgTokens) : "—";
  el.textContent = `共 ${recallRows.length} 条 · 已标注 ${labeled.length} · 召回率 ${rate} · 平均耗时 ${avgTimeText} · 平均 Token ${avgTokenText}`;
}

function recallRowsForDisplay() {
  return recallRows;
}

function recallSerialNo(rowId) {
  const idx = recallRows.findIndex((r) => r.id === rowId);
  return idx >= 0 ? idx + 1 : 0;
}

function recallCardClass(row) {
  if (row.recalled === "yes") return "recalled-yes";
  if (row.recalled === "no") return "recalled-no";
  return "";
}

function updateRecallListInfo() {
  const info = $("#recallListInfo");
  if (!info) return;
  info.textContent = recallRows.length > 0 ? `共 ${recallRows.length} 条` : "暂无数据";
}

function renderRecallList() {
  const body = $("#recallListBody");
  if (!body) return;
  const displayRows = recallRowsForDisplay();
  body.innerHTML = displayRows
    .map(
      (row) => `<div class="recallCard ${recallCardClass(row)}" data-row-id="${escapeHtml(row.id)}">
        <div class="recallCardRow">
          <label class="recallCheckWrap">
            <input type="checkbox" class="recallRowCheck" data-id="${escapeHtml(row.id)}" ${recallSelected.has(row.id) ? "checked" : ""} />
            <span class="recallSerial">${recallSerialNo(row.id)}</span>
          </label>
          <div class="recallField recallFieldQ">
            <span class="recallFieldLabel">问题</span>
            <textarea class="recallQ" data-id="${escapeHtml(row.id)}" rows="1" placeholder="输入人工问题…">${escapeHtml(row.question)}</textarea>
          </div>
          <div class="recallField recallFieldView">
            <span class="recallFieldLabel">模型回答</span>
            <button type="button" class="btn btnXs recallViewBtn" data-id="${escapeHtml(row.id)}" ${row.answers?.length ? "" : "disabled"}>查看</button>
          </div>
          <div class="recallField recallFieldRecall">
            <span class="recallFieldLabel">是否召回</span>
            <select class="recallLabel" data-id="${escapeHtml(row.id)}">
              <option value="" ${row.recalled == null ? "selected" : ""}>未标注</option>
              <option value="yes" ${row.recalled === "yes" ? "selected" : ""}>是</option>
              <option value="no" ${row.recalled === "no" ? "selected" : ""}>否</option>
            </select>
          </div>
        </div>
      </div>`
    )
    .join("");

  body.querySelectorAll(".recallQ").forEach((ta) => {
    ta.addEventListener("change", () => {
      const row = recallRows.find((r) => r.id === ta.dataset.id);
      if (row) row.question = ta.value.trim();
    });
  });
  body.querySelectorAll(".recallLabel").forEach((sel) => {
    sel.addEventListener("change", () => {
      const row = recallRows.find((r) => r.id === sel.dataset.id);
      if (row) row.recalled = sel.value || null;
      updateRecallStat();
      const card = sel.closest(".recallCard");
      if (card) {
        card.classList.remove("recalled-yes", "recalled-no");
        const cls = recallCardClass(row);
        if (cls) card.classList.add(cls);
      }
    });
  });
  body.querySelectorAll(".recallRowCheck").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) recallSelected.add(cb.dataset.id);
      else recallSelected.delete(cb.dataset.id);
      updateRecallSelectAllState();
    });
  });
  body.querySelectorAll(".recallViewBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = recallRows.find((r) => r.id === btn.dataset.id);
      if (!row?.answers?.length) return showToast("请先运行该行", "error");
      if (typeof window.renderRecallAnswerModal === "function") {
        window.renderRecallAnswerModal(row.answers, recallKbId(), row.question);
      }
    });
  });
  updateRecallSelectAllState();
  updateRecallStat();
  updateRecallListInfo();
}

function updateRecallSelectAllState() {
  const selectAll = $("#recallSelectAll");
  if (!selectAll) return;
  selectAll.checked =
    recallRows.length > 0 && recallRows.every((r) => recallSelected.has(r.id));
  selectAll.indeterminate =
    recallRows.some((r) => recallSelected.has(r.id)) &&
    !recallRows.every((r) => recallSelected.has(r.id));
}

async function loadRecallTests() {
  const kbId = recallKbId();
  if (!kbId) {
    recallRows = [];
    renderRecallList();
    return;
  }
  try {
    const doc = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/recall-tests`);
    recallRows = (doc.items || []).map((r) => newRecallRow(r));
  } catch {
    recallRows = [];
  }
  recallSelected.clear();
  renderRecallList();
}

async function saveRecallTests() {
  const kbId = recallKbId();
  if (!kbId) return showToast("请选择知识库", "error");
  await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/recall-tests`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: recallRows }),
  });
  showToast("召回测试已保存");
}

async function runRecallRow(row) {
  const kbId = recallKbId();
  const question = (row.question || "").trim();
  if (!question || !kbId) return;
  const profileId = selectedMatchProfileId($("#recallMatchProfileSelect"));
  recallLastProfileId = profileId;
  const resp = await fetch("/ask/confidence/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      kb_id: kbId,
      top_k: recallTopK(),
      match_profile_id: profileId,
    }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  let doneData = null;
  await consumeSseStream(resp, (evt) => {
    if (evt.event === "done") doneData = evt.data;
  });
  if (doneData) {
    row.run_at = new Date().toISOString();
    row.candidates = doneData.match?.candidates || [];
    row.answers = doneData.answers || [];
    row.timings = doneData.timings || null;
    row.match_profile_id = profileId;
    row.model_label = matchProfileLabel(profileId);
  }
}

function isRecallLabeled(row) {
  return row.recalled === "yes" || row.recalled === "no";
}

function renderRecallMetrics(rows) {
  const ran = rows.filter((r) => r.timings?.total_ms != null);
  if (!ran.length) return;
  if (typeof updateModuleMetricsVisibility === "function") updateModuleMetricsVisibility();
  switchRightTab("timing");
  const totals = {
    total_ms: 0,
    prepare_ms: 0,
    match_ms: 0,
    match_first_token_ms: 0,
    lookup_ms: 0,
  };
  let tokenSum = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const breakdown = [];
  ran.forEach((row) => {
    const t = row.timings || {};
    totals.total_ms += Number(t.total_ms) || 0;
    totals.prepare_ms += Number(t.prepare_ms) || 0;
    totals.match_ms += Number(t.match_ms) || 0;
    totals.match_first_token_ms += Number(t.match_first_token_ms) || 0;
    totals.lookup_ms += Number(t.lookup_ms) || 0;
    const u = t.tokens || {};
    tokenSum = sumTokenUsage(tokenSum, u);
    breakdown.push({ phase: `#${recallSerialNo(row.id)}`, usage: u });
  });
  renderTimingsPanel($("#debugTimingPanel"), totals, "运行后显示", "ask");
  renderTokenPanel($("#debugTokenPanel"), { tokens: tokenSum, token_breakdown: breakdown }, "运行后显示");
}

async function batchRunRecall() {
  let all;
  if (recallSelected.size > 0) {
    all = recallRows.filter((r) => recallSelected.has(r.id) && (r.question || "").trim());
    if (!all.length) return showToast("所选行无有效问题", "error");
  } else {
    all = recallRows.filter((r) => (r.question || "").trim() && !isRecallLabeled(r));
    if (!all.length) return showToast("无待运行行（已标注的行会跳过）", "error");
  }
  await withButtonRunning($("#recallRunBtn"), "运行中…", async () => {
    for (const row of all) {
      await runRecallRow(row);
      renderRecallList();
    }
    showToast(`已运行 ${all.length} 条`);
    renderRecallMetrics(all);
  });
}

function recallExportMarkdown() {
  const kbId = recallKbId();
  const profileId = recallLastProfileId || selectedMatchProfileId($("#recallMatchProfileSelect"));
  const modelLabel = matchProfileLabel(profileId);
  const labeled = recallRows.filter((r) => r.recalled === "yes" || r.recalled === "no");
  const yes = recallRows.filter((r) => r.recalled === "yes").length;
  const recallRate = labeled.length ? `${((yes / labeled.length) * 100).toFixed(1)}% (${yes}/${labeled.length})` : "—";

  const withTimings = recallRows.filter((r) => r.timings?.total_ms != null);
  const totals = withTimings.map((r) => Number(r.timings.total_ms));
  const firstTokens = withTimings.map((r) => Number(r.timings.match_first_token_ms)).filter((n) => Number.isFinite(n));
  const tokens = withTimings.map((r) => Number(r.timings?.tokens?.total_tokens || 0)).filter((n) => n > 0);

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const max = (arr) => (arr.length ? Math.max(...arr) : null);

  const avgTotal = avg(totals);
  const avgFirst = avg(firstTokens);
  const avgTok = avg(tokens);
  const maxTotal = max(totals);
  const maxTok = max(tokens);

  let md = `# 召回度测试报告\n\n`;
  md += `- 知识库：${kbDisplayName(kbId)} (${kbId})\n`;
  md += `- 回答模型：${modelLabel}\n`;
  md += `- 测试时间：${new Date().toISOString()}\n`;
  md += `- Top K：${recallTopK()}\n\n`;
  md += `## 汇总\n\n`;
  md += `| 指标 | 值 |\n|------|-----|\n`;
  md += `| 召回率 | ${recallRate} |\n`;
  md += `| 平均总耗时 | ${avgTotal != null ? fmtMs(avgTotal) : "—"} |\n`;
  md += `| 平均首 token | ${avgFirst != null ? fmtMs(avgFirst) : "—"} |\n`;
  md += `| 平均 Token | ${avgTok != null ? Math.round(avgTok) : "—"} |\n`;
  md += `| 最大总耗时 | ${maxTotal != null ? fmtMs(maxTotal) : "—"} |\n`;
  md += `| 最大 Token | ${maxTok != null ? maxTok : "—"} |\n\n`;
  md += `## 明细\n\n`;
  md += `| 序号 | 人工问题 | 是否召回 | Top1 ID | 置信度 | 总耗时 | 首 token | Token |\n`;
  md += `|------|----------|----------|---------|--------|--------|----------|-------|\n`;
  recallRows.forEach((row, i) => {
    const top = row.answers?.[0];
    const recalled =
      row.recalled === "yes" ? "是" : row.recalled === "no" ? "否" : "未标注";
    const conf = top?.confidence != null ? fmtConfidence(top.confidence) : "—";
    const t = row.timings;
    md += `| ${i + 1} | ${(row.question || "").replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${recalled} | ${top?.id || "—"} | ${conf} | ${t?.total_ms != null ? fmtMs(t.total_ms) : "—"} | ${t?.match_first_token_ms != null ? fmtMs(t.match_first_token_ms) : "—"} | ${t?.tokens?.total_tokens ?? "—"} |\n`;
  });

  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `recall_report_${kbId || "kb"}_${Date.now()}.md`;
  a.click();
}

let recallLoadedKbId = "";

async function recallViewEnter() {
  await populateKbSelect($("#recallKbSelect"));
  await refreshMatchProfileSelects();
  const kbId = recallKbId();
  if (kbId !== recallLoadedKbId) {
    await loadRecallTests();
    recallLoadedKbId = kbId;
  } else if (!recallRows.length && kbId) {
    await loadRecallTests();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  recallPageSize = loadRecallPageSize();
  applyRecallPageSize(recallPageSize);

  $("#recallPageSizeSelect")?.addEventListener("change", (e) => {
    applyRecallPageSize(parseInt(e.target.value, 10));
  });

  $("#recallAddRowBtn")?.addEventListener("click", () => {
    recallRows.push(newRecallRow());
    renderRecallList();
    const scroll = $("#recallListScroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });
  $("#recallDeleteBtn")?.addEventListener("click", () => {
    if (!recallSelected.size) return showToast("请先勾选行", "error");
    recallRows = recallRows.filter((r) => !recallSelected.has(r.id));
    recallSelected.clear();
    renderRecallList();
  });
  $("#recallRunBtn")?.addEventListener("click", batchRunRecall);
  $("#recallSaveBtn")?.addEventListener("click", () => saveRecallTests().catch((e) => showToast(e.message, "error")));
  $("#recallKbSelect")?.addEventListener("change", () => {
    recallLoadedKbId = "";
    loadRecallTests();
  });
  $("#recallSelectAll")?.addEventListener("change", (e) => {
    if (e.target.checked) recallRows.forEach((r) => recallSelected.add(r.id));
    else recallSelected.clear();
    renderRecallList();
  });
  $("#recallImportBtn")?.addEventListener("click", () => {
    showModal(
      "批量导入问题",
      `<p class="muted">JSON 数组格式，每项含 question 字段：</p>
       <label class="fieldLabel"><textarea id="recallImportJson" rows="10" class="jsonEditor" placeholder='[{"question":"如何使用曝光补偿？"}]'></textarea></label>`,
      async () => {
        const raw = ($("#recallImportJson")?.value || "").trim();
        let arr = JSON.parse(raw);
        if (!Array.isArray(arr)) {
          if (arr?.items && Array.isArray(arr.items)) arr = arr.items;
          else throw new Error("须为 JSON 数组或 {items:[...]}");
        }
        arr.forEach((x) => recallRows.push(newRecallRow(typeof x === "string" ? { question: x } : x)));
        renderRecallList();
      },
      true
    );
  });
  $("#recallExportBtn")?.addEventListener("click", recallExportMarkdown);
});
