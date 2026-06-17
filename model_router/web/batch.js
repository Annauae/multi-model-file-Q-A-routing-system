let batchTests = [];
let batchSelectedId = "";
let batchRunningId = "";
let batchRunActive = false;
let batchEditingId = "";
const batchCheckedIds = new Set();

function closeBatchDropdowns() {
  $$("#viewBatch .dropdownMenu").forEach((m) => {
    m.classList.add("hidden");
    m.style.position = "";
    m.style.top = "";
    m.style.left = "";
    m.style.right = "";
    m.style.zIndex = "";
  });
}

function toggleBatchDropdown(toggleBtn) {
  const box = toggleBtn?.closest(".headDropdown");
  const menu = box?.querySelector(".dropdownMenu");
  if (!menu) return;
  const willOpen = menu.classList.contains("hidden");
  closeBatchDropdowns();
  if (!willOpen) return;
  menu.classList.remove("hidden");
  const r = toggleBtn.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 108;
  let left = r.right - menuWidth;
  left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
  menu.style.position = "fixed";
  menu.style.zIndex = "200";
  menu.style.right = "auto";
  menu.style.left = `${left}px`;
  menu.style.top = `${r.bottom + 4}px`;
}

function setBatchRunButtonsDisabled(disabled) {
  $$('#viewBatch [data-batch-action="runSelected"], #viewBatch [data-batch-action="runAll"]').forEach((btn) => {
    btn.disabled = disabled;
  });
}

function fmtAccuracy(pct) {
  if (pct == null || pct === "") return "—";
  return `${Math.round(Number(pct))}%`;
}

function batchSummary(text, max = 48) {
  const s = (text || "").trim().replace(/\s+/g, " ");
  if (!s) return "（空）";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function batchKnowledgeSource(item) {
  if (!item) return "";
  if (item.knowledge_source) return item.knowledge_source;
  const aid = (item.last_agent_id || "").trim();
  const rid = String(item.router_id || "").trim();
  return aid && rid ? `files/router_${rid}/agent_${aid}/md` : "";
}

function renderBatchAnswerHtml(text, sourceFile) {
  const body = (text || "").trim();
  if (!body) return `<div class="empty">未运行</div>`;
  return `<div class="answerText">${renderDisplayAnswerHtml(body, sourceFile || "")}</div>`;
}

function getBatchCheckedIds() {
  return Array.from(batchCheckedIds);
}

function batchRouterSortKey(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function renderBatchQuestionItem(item) {
  const selected = item.id === batchSelectedId ? " selected" : "";
  const running = item.id === batchRunningId ? " running" : "";
  const checked = batchCheckedIds.has(item.id) ? " checked" : "";
  const statusClass = item.status === "error" ? "err" : item.status === "running" ? "run" : "ok";
  return `
    <div class="batchQuestionItem${selected}${running}" data-batch-id="${escapeHtml(item.id)}">
      <label class="batchQuestionCheck" title="勾选">
        <input type="checkbox" class="batchQuestionCheckInput" value="${escapeHtml(item.id)}"${checked} />
      </label>
      <button type="button" class="batchQuestionMain">
        <span class="batchQuestionText">${escapeHtml(batchSummary(item.question))}</span>
        <span class="batchAccuracy ${statusClass}">${item.id === batchRunningId ? "…" : fmtAccuracy(item.accuracy_percent)}</span>
      </button>
    </div>`;
}

function renderBatchQuestionList() {
  const box = $("#batchQuestionList");
  if (!box) return;
  if (!batchTests.length) {
    box.innerHTML = `<div class="empty">暂无测试用例，点击「操作 → 新增」添加。</div>`;
    return;
  }
  const groups = new Map();
  for (const item of batchTests) {
    const rid = String(item.router_id || "1").trim() || "1";
    if (!groups.has(rid)) groups.set(rid, []);
    groups.get(rid).push(item);
  }
  const sortedRids = [...groups.keys()].sort(batchRouterSortKey);
  box.innerHTML = sortedRids
    .map((rid) => {
      const label = routerDisplayName(rid, routersCache[rid]);
      const items = groups.get(rid) || [];
      return `
        <div class="batchRouterGroup">
          <div class="batchRouterGroupHead">${escapeHtml(label)}</div>
          ${items.map(renderBatchQuestionItem).join("")}
        </div>`;
    })
    .join("");

  box.querySelectorAll(".batchQuestionItem").forEach((row) => {
    const id = row.dataset.batchId;
    row.querySelector(".batchQuestionMain")?.addEventListener("click", () => {
      selectBatchTest(id, { autoRun: true }).catch((e) => batchLog(e?.message || e, "err"));
    });
    row.querySelector(".batchQuestionCheckInput")?.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    row.querySelector(".batchQuestionCheckInput")?.addEventListener("change", (e) => {
      if (e.target.checked) batchCheckedIds.add(id);
      else batchCheckedIds.delete(id);
    });
  });
}

function syncReferenceEditor(item) {
  const editor = $("#batchReferenceEditor");
  const saveBtn = $("#batchReferenceSaveBtn");
  const preview = $("#batchReferenceAnswer");
  if (!item) {
    editor?.classList.add("hidden");
    saveBtn?.classList.add("hidden");
    if (editor) editor.value = "";
    if (preview) {
      preview.classList.remove("hidden");
      preview.innerHTML = `<div class="empty">—</div>`;
    }
    return;
  }
  editor?.classList.remove("hidden");
  saveBtn?.classList.remove("hidden");
  preview?.classList.remove("hidden");
  const text = item.reference_answer || "";
  if (editor) editor.value = text;
  if (preview) {
    preview.innerHTML = renderBatchAnswerHtml(text, batchKnowledgeSource(item));
  }
}

function renderBatchDetail(item) {
  const title = $("#batchDetailTitle");
  const acc = $("#batchDetailAccuracy");
  const rerun = $("#batchRerunBtn");
  const model = $("#batchModelAnswer");
  if (!item) {
    if (title) title.textContent = "请选择左侧问题";
    if (acc) {
      acc.textContent = "—";
      acc.className = "batchAccuracy";
    }
    rerun?.classList.add("hidden");
    if (model) model.innerHTML = `<div class="empty">未运行</div>`;
    syncReferenceEditor(null);
    return;
  }
  if (title) title.textContent = item.question || "—";
  if (acc) {
    acc.textContent = fmtAccuracy(item.accuracy_percent);
    acc.className = "batchAccuracy";
    if (item.accuracy_percent != null) acc.classList.add("ok");
    if (item.status === "error") acc.classList.add("err");
  }
  rerun?.classList.remove("hidden");
  if (model) {
    if (item.status === "running" || item.id === batchRunningId) {
      model.innerHTML = `<div class="empty">运行中…</div>`;
    } else if (item.model_answer) {
      model.innerHTML = renderBatchAnswerHtml(item.model_answer, batchKnowledgeSource(item));
    } else {
      model.innerHTML = `<div class="empty">未运行</div>`;
    }
  }
  syncReferenceEditor(item);
}

function getBatchItem(id) {
  return batchTests.find((x) => x.id === id) || null;
}

async function loadBatchTests() {
  await loadAllCaches();
  const data = await apiJson("/batch/tests");
  batchTests = data.items || [];
  const valid = new Set(batchTests.map((x) => x.id));
  for (const id of batchCheckedIds) {
    if (!valid.has(id)) batchCheckedIds.delete(id);
  }
  renderBatchQuestionList();
  if (batchSelectedId) {
    renderBatchDetail(getBatchItem(batchSelectedId));
  }
}

async function runBatchTest(itemId, { force = false } = {}) {
  const item = getBatchItem(itemId);
  if (!item) return null;
  if (batchRunningId) return null;
  if (!force && item.status === "done" && item.model_answer) {
    return item;
  }

  batchRunningId = itemId;
  item.status = "running";
  renderBatchQuestionList();
  if (batchSelectedId === itemId) renderBatchDetail(item);

  try {
    const data = await apiJson(`/batch/tests/${encodeURIComponent(itemId)}/run`, { method: "POST" });
    const updated = data.item;
    const idx = batchTests.findIndex((x) => x.id === itemId);
    if (idx >= 0) batchTests[idx] = updated;
    else batchTests.push(updated);
    renderBatchQuestionList();
    if (batchSelectedId === itemId) renderBatchDetail(updated);
    return updated;
  } catch (e) {
    batchLog(`运行失败 [${batchSummary(item.question, 24)}]: ${e?.message || e}`, "err");
    await loadBatchTests();
    throw e;
  } finally {
    batchRunningId = "";
    renderBatchQuestionList();
  }
}

async function runBatchTests(ids, { force = true } = {}) {
  const unique = [...new Set(ids)].filter((id) => getBatchItem(id));
  if (!unique.length) {
    batchLog("未选择测试用例", "warn");
    return;
  }
  if (batchRunActive || batchRunningId) {
    batchLog("已有测试任务进行中", "warn");
    return;
  }
  batchRunActive = true;
  setBatchRunButtonsDisabled(true);
  try {
    let ok = 0;
    for (const id of unique) {
      batchSelectedId = id;
      renderBatchQuestionList();
      renderBatchDetail(getBatchItem(id));
      try {
        await runBatchTest(id, { force });
        ok += 1;
      } catch (e) {
        /* logged in runBatchTest */
      }
    }
    batchLog(`批量测试完成：${ok}/${unique.length} 条`, ok === unique.length ? "ok" : "warn");
  } finally {
    batchRunActive = false;
    setBatchRunButtonsDisabled(false);
  }
}

async function selectBatchTest(id, { autoRun = false } = {}) {
  batchSelectedId = id;
  const item = getBatchItem(id);
  const fileRouterSel = $("#batchFileRouterSelect");
  if (item?.router_id && fileRouterSel) {
    fileRouterSel.value = item.router_id;
    loadAgentFilesList("batch").catch(() => {});
  }
  renderBatchQuestionList();
  renderBatchDetail(item);
  if (!item || !autoRun) return;
  if (item.status === "pending" || !item.model_answer) {
    await runBatchTest(id);
  }
}

async function saveBatchReference() {
  if (!batchSelectedId) return;
  const text = ($("#batchReferenceEditor")?.value || "").trim();
  if (!text) {
    batchLog("参考回答不能为空", "warn");
    return;
  }
  const data = await apiJson(`/batch/tests/${encodeURIComponent(batchSelectedId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference_answer: text }),
  });
  const idx = batchTests.findIndex((x) => x.id === batchSelectedId);
  if (idx >= 0) batchTests[idx] = data.item;
  syncReferenceEditor(data.item);
  batchLog("参考回答已保存", "ok");
}

function setBatchModalMode(mode) {
  const isEdit = mode === "edit";
  const title = $("#batchModalTitle");
  const colTitle = $("#batchModalColTitle");
  const importCol = $("#batchModalImportCol");
  const body = $("#batchAddModal .batchModalBody");
  if (title) title.textContent = isEdit ? "编辑问题" : "批量新增";
  if (colTitle) colTitle.textContent = isEdit ? "编辑问题" : "新增问题";
  importCol?.classList.toggle("hidden", isEdit);
  body?.classList.toggle("editOnly", isEdit);
}

function openBatchAddModal() {
  batchEditingId = "";
  setBatchModalMode("add");
  const sel = $("#batchRouterSelect");
  if (sel) sel.disabled = false;
  loadRoutersCache()
    .then(() => populateRouterSelect($("#batchRouterSelect")))
    .catch(() => {});
  const q = $("#batchFormQuestion");
  const r = $("#batchFormReference");
  if (q) q.value = "";
  if (r) r.value = "";
  $("#batchAddModal")?.classList.remove("hidden");
  q?.focus();
}

function openBatchEditModal() {
  if (!batchSelectedId) {
    batchLog("请先在左侧选择要编辑的问题", "warn");
    return;
  }
  const item = getBatchItem(batchSelectedId);
  if (!item) return;
  batchEditingId = batchSelectedId;
  setBatchModalMode("edit");
  loadRoutersCache()
    .then(() => {
      populateRouterSelect($("#batchRouterSelect"), item.router_id || "1");
      const sel = $("#batchRouterSelect");
      if (sel) sel.disabled = true;
    })
    .catch(() => {});
  const q = $("#batchFormQuestion");
  const r = $("#batchFormReference");
  if (q) q.value = item.question || "";
  if (r) r.value = item.reference_answer || "";
  $("#batchAddModal")?.classList.remove("hidden");
  q?.focus();
}

function closeBatchAddModal() {
  batchEditingId = "";
  const sel = $("#batchRouterSelect");
  if (sel) sel.disabled = false;
  $("#batchAddModal")?.classList.add("hidden");
}

function batchLog(msg, kind = "info") {
  if (typeof appendLog === "function") appendLog(`[批量] ${msg}`, kind);
}

async function saveBatchFormItem() {
  const question = ($("#batchFormQuestion")?.value || "").trim();
  const reference = ($("#batchFormReference")?.value || "").trim();
  if (!question || !reference) {
    batchLog("问题和参考回答不能为空", "warn");
    return;
  }
  if (batchEditingId) {
    const data = await apiJson(`/batch/tests/${encodeURIComponent(batchEditingId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, reference_answer: reference }),
    });
    const idx = batchTests.findIndex((x) => x.id === batchEditingId);
    if (idx >= 0) batchTests[idx] = data.item;
    closeBatchAddModal();
    renderBatchQuestionList();
    renderBatchDetail(data.item);
    batchLog("测试用例已更新", "ok");
    return;
  }
  const router_id = getSelectedRouterIdFrom($("#batchRouterSelect"));
  if (!router_id) {
    batchLog("请选择总 Agent", "warn");
    return;
  }
  const data = await apiJson("/batch/tests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, reference_answer: reference, router_id }),
  });
  batchTests.unshift(data.item);
  batchSelectedId = data.item.id;
  batchCheckedIds.add(data.item.id);
  $("#batchFormQuestion").value = "";
  $("#batchFormReference").value = "";
  closeBatchAddModal();
  renderBatchQuestionList();
  await selectBatchTest(data.item.id, { autoRun: true });
  batchLog("已保存测试用例", "ok");
}

async function deleteBatchTest() {
  if (!batchSelectedId) {
    batchLog("请先在左侧选择要删除的问题", "warn");
    return;
  }
  const item = getBatchItem(batchSelectedId);
  if (!item) return;
  const label = batchSummary(item.question, 40);
  if (!confirm(`确定删除测试用例「${label}」？`)) return;
  await apiJson(`/batch/tests/${encodeURIComponent(batchSelectedId)}`, { method: "DELETE" });
  batchCheckedIds.delete(batchSelectedId);
  batchSelectedId = "";
  await loadBatchTests();
  renderBatchDetail(null);
  batchLog("测试用例已删除", "ok");
}

async function importBatchBulk() {
  const text = ($("#batchBulkImport")?.value || "").trim();
  if (!text) {
    batchLog("导入内容为空", "warn");
    return;
  }
  const router_id = getSelectedRouterIdFrom($("#batchRouterSelect"));
  const data = await apiJson("/batch/tests/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, format: "auto", router_id: router_id || "" }),
  });
  await loadBatchTests();
  if (data.items?.length) {
    for (const it of data.items) batchCheckedIds.add(it.id);
    batchSelectedId = data.items[0].id;
    renderBatchQuestionList();
    await selectBatchTest(data.items[0].id, { autoRun: true });
  }
  $("#batchBulkImport").value = "";
  closeBatchAddModal();
  batchLog(`已导入 ${data.imported} 条`, "ok");
}

function bindBatch() {
  initFilePanel("batch", {
    select: "#batchFileSelect",
    preview: "#batchFilePreviewBox",
    source: "#batchFileSourceBox",
    previewBtn: "#batchFilePreviewBtn",
    sourceBtn: "#batchFileSourceBtn",
    onError: (msg) => batchLog(msg, "err"),
  });
  bindFilePanel("batch");

  $("#batchFileRouterSelect")?.addEventListener("change", () => {
    refreshBatchFileList();
  });

  $$("#viewBatch .dropdownToggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBatchDropdown(btn);
    });
  });
  document.addEventListener("click", (e) => {
    if (!$("#viewBatch")?.classList.contains("active")) return;
    if (!e.target.closest(".headDropdown")) closeBatchDropdowns();
  });

  $$("[data-batch-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeBatchDropdowns();
      const action = btn.dataset.batchAction;
      const run = () => {
        if (action === "runSelected") {
          const ids = getBatchCheckedIds();
          if (!ids.length) {
            batchLog("请先勾选要测试的问题", "warn");
            return;
          }
          return runBatchTests(ids, { force: true });
        }
        if (action === "runAll") {
          return runBatchTests(
            batchTests.map((x) => x.id),
            { force: true }
          );
        }
        if (action === "add") {
          openBatchAddModal();
          return;
        }
        if (action === "edit") {
          openBatchEditModal();
          return;
        }
        if (action === "delete") return deleteBatchTest();
      };
      Promise.resolve(run()).catch((e) => batchLog(e?.message || e, "err"));
    });
  });

  $("#batchModalBackBtn")?.addEventListener("click", closeBatchAddModal);
  $$("[data-batch-modal-close]").forEach((el) => {
    el.addEventListener("click", closeBatchAddModal);
  });
  $("#batchFormSaveBtn")?.addEventListener("click", () => {
    saveBatchFormItem().catch((e) => batchLog(e?.message || e, "err"));
  });
  $("#batchBulkImportBtn")?.addEventListener("click", () => {
    importBatchBulk().catch((e) => batchLog(e?.message || e, "err"));
  });
  $("#batchRerunBtn")?.addEventListener("click", () => {
    if (!batchSelectedId) return;
    runBatchTest(batchSelectedId, { force: true }).catch((e) => batchLog(e?.message || e, "err"));
  });
  $("#batchReferenceSaveBtn")?.addEventListener("click", () => {
    saveBatchReference().catch((e) => batchLog(e?.message || e, "err"));
  });
  $("#batchReferenceEditor")?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveBatchReference().catch((err) => batchLog(err?.message || err, "err"));
    }
  });
}

async function batchViewEnter() {
  try {
    await loadAllCaches();
    populateRouterSelect($("#batchFileRouterSelect"));
    const item = getBatchItem(batchSelectedId);
    if (item?.router_id && routersCache[item.router_id]) {
      $("#batchFileRouterSelect").value = item.router_id;
    }
    await loadBatchTests();
    await loadAgentFilesList("batch");
  } catch (e) {
    batchLog(e?.message || e, "err");
  }
}

bindBatch();
