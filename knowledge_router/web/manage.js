/**
 * manage.js — 管理页：知识库 CRUD、FAQ 编辑、JSON 整文件、匹配提示词
 */
let manageSelectedKbId = "";
let manageSelectedItemId = "";
let manageEditorTab = "form";
let manageQuestionsDoc = null;
let editAnswerMode = "preview";

function manageLog(msg, kind = "info") {
  if (typeof appendLog === "function") appendLog(`[管理] ${msg}`, kind);
}

function switchEditorTab(tab) {
  manageEditorTab = tab;
  $$("[data-editor-tab]").forEach((b) => b.classList.toggle("active", b.dataset.editorTab === tab));
  $("#editorTabForm")?.classList.toggle("active", tab === "form");
  $("#editorTabJson")?.classList.toggle("active", tab === "json");
  $("#editorTabPrompt")?.classList.toggle("active", tab === "prompt");
}

$$("[data-editor-tab]").forEach((btn) => {
  btn.addEventListener("click", () => switchEditorTab(btn.dataset.editorTab));
});

async function manageViewEnter() {
  await loadKbCache();
  if (!manageSelectedKbId && Object.keys(kbCache).length) {
    manageSelectedKbId = Object.keys(kbCache).sort()[0];
  }
  renderKbList();
  await loadManageQuestions();
  renderQuestionList();
  loadPromptEditor();
  populateKbSelect($("#kbSelect"), manageSelectedKbId);
}

function renderKbList() {
  const box = $("#kbList");
  if (!box) return;
  const entries = Object.entries(kbCache || {}).sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]));
  if (!entries.length) {
    box.innerHTML = `<div class="empty">暂无知识库，点击「新增」。</div>`;
    return;
  }
  box.innerHTML = entries
    .map(([id, cfg]) => {
      const active = id === manageSelectedKbId ? " active" : "";
      const count = cfg.enabled_count ?? cfg.item_count ?? 0;
      return `<button type="button" class="listItem${active}" data-kb-id="${escapeHtml(id)}">
        <span class="listTitle">${escapeHtml(kbDisplayName(id, cfg))}</span>
        <span class="listMeta">${escapeHtml(id)} · ${count} 条启用</span>
      </button>`;
    })
    .join("");
  box.querySelectorAll("[data-kb-id]").forEach((el) => {
    el.addEventListener("click", async () => {
      manageSelectedKbId = el.dataset.kbId;
      manageSelectedItemId = "";
      renderKbList();
      await loadManageQuestions();
      renderQuestionList();
      loadPromptEditor();
      populateKbSelect($("#kbSelect"), manageSelectedKbId);
    });
  });
}

async function loadManageQuestions() {
  if (!manageSelectedKbId) {
    manageQuestionsDoc = null;
    clearItemEditor();
    return;
  }
  const data = await apiJson(`/knowledge-bases/${encodeURIComponent(manageSelectedKbId)}/questions`);
  manageQuestionsDoc = data.document;
  $("#jsonEditor").value = JSON.stringify(manageQuestionsDoc, null, 2);
  $("#jsonEditorError")?.classList.add("hidden");
}

function renderQuestionList() {
  const box = $("#questionList");
  if (!box) return;
  const q = ($("#questionSearch")?.value || "").trim().toLowerCase();
  const items = (manageQuestionsDoc?.items || []).filter((it) => {
    if (!q) return true;
    const hay = [it.question, ...(it.variants || []), it.id].join(" ").toLowerCase();
    return hay.includes(q);
  });
  if (!items.length) {
    box.innerHTML = `<div class="empty">无匹配条目</div>`;
    return;
  }
  box.innerHTML = items
    .map((it) => {
      const active = it.id === manageSelectedItemId ? " active" : "";
      const badge = it.enabled === false ? `<span class="badge off">禁用</span>` : `<span class="badge on">启用</span>`;
      return `<button type="button" class="listItem${active}" data-item-id="${escapeHtml(it.id)}">
        ${badge}
        <span class="listTitle">${escapeHtml(it.question)}</span>
        <span class="listMeta">${escapeHtml(it.id)}</span>
      </button>`;
    })
    .join("");
  box.querySelectorAll("[data-item-id]").forEach((el) => {
    el.addEventListener("click", () => {
      manageSelectedItemId = el.dataset.itemId;
      renderQuestionList();
      loadItemEditor(manageSelectedItemId);
      switchEditorTab("form");
    });
  });
}

function clearItemEditor() {
  $("#editItemId").value = "";
  $("#editQuestion").value = "";
  $("#editVariants").value = "";
  $("#editAnswer").value = "";
  $("#editCitations").value = "[]";
  $("#editEnabled").checked = true;
  $("#editAnswerPreview").innerHTML = `<div class="empty">选择条目后编辑</div>`;
}

function loadItemEditor(itemId) {
  const item = (manageQuestionsDoc?.items || []).find((x) => x.id === itemId);
  if (!item) {
    clearItemEditor();
    return;
  }
  $("#editItemId").value = item.id;
  $("#editQuestion").value = item.question || "";
  $("#editVariants").value = (item.variants || []).join("\n");
  $("#editAnswer").value = item.answer || "";
  $("#editCitations").value = JSON.stringify(item.citations || [], null, 2);
  $("#editEnabled").checked = item.enabled !== false;
  refreshEditAnswerPreview();
}

function setEditAnswerMode(mode) {
  editAnswerMode = mode === "source" ? "source" : "preview";
  $("#editAnswerPreviewBtn")?.classList.toggle("primary", editAnswerMode === "preview");
  $("#editAnswerPreviewBtn")?.classList.toggle("ghost", editAnswerMode !== "preview");
  $("#editAnswerSourceBtn")?.classList.toggle("primary", editAnswerMode === "source");
  $("#editAnswerSourceBtn")?.classList.toggle("ghost", editAnswerMode !== "source");
  $("#editAnswer")?.classList.toggle("hidden", editAnswerMode !== "source");
  $("#editAnswerPreview")?.classList.toggle("hidden", editAnswerMode === "source");
  refreshEditAnswerPreview();
}

function refreshEditAnswerPreview() {
  const box = $("#editAnswerPreview");
  if (!box || editAnswerMode !== "preview") return;
  const text = $("#editAnswer")?.value || "";
  box.innerHTML = text ? renderAnswerMarkdownPreview(text, manageSelectedKbId) : `<div class="empty">（空）</div>`;
}

function loadPromptEditor() {
  const cfg = kbCache[manageSelectedKbId] || {};
  $("#promptEditor").value = cfg.match_prompt || "";
}

async function saveCurrentEditor() {
  if (!manageSelectedKbId) return alert("请选择知识库");
  if (manageEditorTab === "prompt") {
    await apiJson(`/knowledge-bases/${encodeURIComponent(manageSelectedKbId)}/prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ match_prompt: $("#promptEditor").value || "" }),
    });
    await loadKbCache();
    renderKbList();
    manageLog("匹配提示词已保存", "ok");
    return;
  }
  if (manageEditorTab === "json") {
    let parsed;
    try {
      parsed = JSON.parse($("#jsonEditor").value || "{}");
      $("#jsonEditorError")?.classList.add("hidden");
    } catch (e) {
      $("#jsonEditorError").textContent = String(e.message || e);
      $("#jsonEditorError")?.classList.remove("hidden");
      return;
    }
    const data = await apiJson(`/knowledge-bases/${encodeURIComponent(manageSelectedKbId)}/questions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    manageQuestionsDoc = data.document;
    renderQuestionList();
    manageLog("JSON 已保存并重载缓存", "ok");
    return;
  }
  const itemId = ($("#editItemId").value || "").trim();
  if (!itemId) return alert("请选择或新增条目");
  let citations = [];
  try {
    citations = JSON.parse($("#editCitations").value || "[]");
  } catch (e) {
    return alert("citations JSON 无效");
  }
  const body = {
    id: itemId,
    question: ($("#editQuestion").value || "").trim(),
    variants: ($("#editVariants").value || "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean),
    answer: $("#editAnswer").value || "",
    citations,
    enabled: $("#editEnabled").checked,
  };
  if (!body.question || !body.answer) return alert("标准问题与回答不能为空");
  await apiJson(
    `/knowledge-bases/${encodeURIComponent(manageSelectedKbId)}/questions/items/${encodeURIComponent(itemId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  await loadManageQuestions();
  renderQuestionList();
  manageLog(`条目 ${itemId} 已保存`, "ok");
}

async function addKnowledgeBase() {
  const name = prompt("知识库名称", "新知识库");
  if (!name?.trim()) return;
  const data = await apiJson("/knowledge-bases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  manageSelectedKbId = data.kb_id;
  await loadKbCache();
  renderKbList();
  await loadManageQuestions();
  renderQuestionList();
  manageLog(`已创建知识库 ${data.kb_id}`, "ok");
}

async function renameKnowledgeBase() {
  if (!manageSelectedKbId) return alert("请选择知识库");
  const cfg = kbCache[manageSelectedKbId] || {};
  const name = prompt("新名称", cfg.name || "");
  if (!name?.trim()) return;
  await apiJson(`/knowledge-bases/${encodeURIComponent(manageSelectedKbId)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadKbCache();
  renderKbList();
  manageLog("已重命名", "ok");
}

async function deleteKnowledgeBase() {
  if (!manageSelectedKbId) return alert("请选择知识库");
  if (!confirm(`确定删除知识库 ${manageSelectedKbId}？`)) return;
  await apiJson(`/knowledge-bases/${encodeURIComponent(manageSelectedKbId)}`, { method: "DELETE" });
  manageSelectedKbId = "";
  manageSelectedItemId = "";
  await loadKbCache();
  const ids = Object.keys(kbCache);
  if (ids.length) manageSelectedKbId = ids.sort()[0];
  renderKbList();
  await loadManageQuestions();
  renderQuestionList();
  manageLog("知识库已删除", "warn");
}

async function reloadKnowledgeBaseCache() {
  if (!manageSelectedKbId) return;
  await apiJson(`/knowledge-bases/${encodeURIComponent(manageSelectedKbId)}/reload`, { method: "POST" });
  await loadManageQuestions();
  manageLog("已从磁盘重载内存缓存", "ok");
}

function addQuestionItem() {
  if (!manageSelectedKbId) return alert("请选择知识库");
  const id = prompt("新条目 ID", `q${Date.now().toString(36)}`);
  if (!id?.trim()) return;
  manageSelectedItemId = id.trim();
  manageQuestionsDoc = manageQuestionsDoc || { version: 1, items: [] };
  if ((manageQuestionsDoc.items || []).some((x) => x.id === manageSelectedItemId)) {
    return alert("ID 已存在");
  }
  const newItem = {
    id: manageSelectedItemId,
    question: "新问题？",
    variants: [],
    answer: "回答内容",
    citations: [],
    enabled: true,
  };
  manageQuestionsDoc.items = [...(manageQuestionsDoc.items || []), newItem];
  renderQuestionList();
  loadItemEditor(manageSelectedItemId);
  switchEditorTab("form");
}

$$("[data-kb-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    $$(".dropdownMenu").forEach((m) => m.classList.add("hidden"));
    const action = btn.dataset.kbAction;
    if (action === "add") await addKnowledgeBase();
    if (action === "rename") await renameKnowledgeBase();
    if (action === "delete") await deleteKnowledgeBase();
    if (action === "reload") await reloadKnowledgeBaseCache();
  });
});

$("#saveEditorBtn")?.addEventListener("click", () => saveCurrentEditor().catch((e) => alert(e.message || e)));
$("#addQuestionBtn")?.addEventListener("click", addQuestionItem);
$("#questionSearch")?.addEventListener("input", renderQuestionList);
$("#editAnswerPreviewBtn")?.addEventListener("click", () => setEditAnswerMode("preview"));
$("#editAnswerSourceBtn")?.addEventListener("click", () => setEditAnswerMode("source"));
$("#editAnswer")?.addEventListener("input", refreshEditAnswerPreview);

setEditAnswerMode("preview");

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s" && $("#viewManage")?.classList.contains("active")) {
    e.preventDefault();
    saveCurrentEditor().catch((err) => alert(err.message || err));
  }
});
