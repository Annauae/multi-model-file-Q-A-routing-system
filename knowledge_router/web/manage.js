let selectedKbId = "";
let selectedItemId = "";
let checkedItemIds = new Set();
let currentDoc = { version: 1, items: [] };
let editorTab = "item";

function setEditorTab(name) {
  editorTab = name;
  $$("[data-editor-tab]").forEach((b) => b.classList.toggle("active", b.dataset.editorTab === name));
  $$("#editorTabItem,#editorTabJson,#editorTabPrompt").forEach((p) => p.classList.remove("active"));
  const pane = $(`#editorTab${name.charAt(0).toUpperCase()}${name.slice(1)}`);
  pane?.classList.add("active");
  if (name === "prompt") refreshPromptPreview();
  if (name === "json") syncJsonEditorFromItem();
}

function itemFromEditorFields() {
  const id = ($("#editId")?.value || "").trim();
  if (!id) return null;
  return {
    id,
    question: ($("#editQuestion")?.value || "").trim(),
    variants: ($("#editVariants")?.value || "").split("\n").map((s) => s.trim()).filter(Boolean),
    answer: $("#editAnswer")?.value || "",
    enabled: $("#editEnabled")?.checked !== false,
  };
}

function syncJsonEditorFromItem() {
  const editor = $("#jsonEditor");
  if (!editor) return;
  if (!selectedItemId) {
    editor.value = "";
    editor.placeholder = "请先在左侧选择一条标准问题";
    return;
  }
  const item = itemFromEditorFields() || (currentDoc.items || []).find((x) => x.id === selectedItemId);
  if (!item) {
    editor.value = "";
    return;
  }
  editor.placeholder = "";
  editor.value = JSON.stringify(item, null, 2);
}

async function refreshKbList() {
  await loadKbCache();
  const list = $("#kbList");
  const ids = Object.keys(kbCache).sort((a, b) => Number(a) - Number(b));
  list.innerHTML = ids.length
    ? ids
        .map(
          (id) =>
            `<div class="listItem ${id === selectedKbId ? "active" : ""}" data-kb-id="${escapeHtml(id)}"><div class="listItemContent"><div>${escapeHtml(kbDisplayName(id))}</div><div class="sub">kb_${escapeHtml(id)} · ${kbCache[id].enabled_count ?? 0} 题</div></div></div>`
        )
        .join("")
    : `<div class="empty">暂无知识库</div>`;
  list.querySelectorAll(".listItem[data-kb-id]").forEach((el) => {
    el.addEventListener("click", () => selectKb(el.dataset.kbId));
  });
}

async function selectKb(kbId) {
  selectedKbId = kbId;
  selectedItemId = "";
  checkedItemIds.clear();
  await refreshKbList();
  await loadItems();
  clearItemEditor();
  syncJsonEditorFromItem();
  await loadMatchPrompt();
}

async function loadItems() {
  if (!selectedKbId) {
    $("#itemList").innerHTML = `<div class="empty">请选择知识库</div>`;
    return;
  }
  currentDoc = await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions`);
  renderItemList();
}

function visibleItems() {
  const q = ($("#itemSearch")?.value || "").trim().toLowerCase();
  return (currentDoc.items || []).filter((it) => {
    if (!q) return true;
    const hay = [it.id, it.question, ...(it.variants || [])].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function renderItemList() {
  const items = visibleItems();
  const list = $("#itemList");
  list.innerHTML = items.length
    ? items
        .map((it) => {
          const checked = checkedItemIds.has(it.id) ? "checked" : "";
          return `<div class="listItem ${it.id === selectedItemId ? "active" : ""}" data-item-id="${escapeHtml(it.id)}">
            <label class="listCheck" onclick="event.stopPropagation()"><input type="checkbox" class="itemCheck" data-item-id="${escapeHtml(it.id)}" ${checked} /></label>
            <div class="listItemContent"><div>${escapeHtml(it.question)}</div><div class="sub">${escapeHtml(it.id)}${it.enabled === false ? " · 已禁用" : ""}</div></div>
          </div>`;
        })
        .join("")
    : `<div class="empty">无条目</div>`;
  list.querySelectorAll(".listItem[data-item-id]").forEach((el) => {
    el.addEventListener("click", () => selectItem(el.dataset.itemId));
  });
  list.querySelectorAll(".itemCheck").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) checkedItemIds.add(cb.dataset.itemId);
      else checkedItemIds.delete(cb.dataset.itemId);
    });
  });
}

function selectItem(itemId) {
  selectedItemId = itemId;
  renderItemList();
  const item = (currentDoc.items || []).find((x) => x.id === itemId);
  if (!item) return;
  $("#editId").value = item.id;
  $("#editQuestion").value = item.question || "";
  $("#editVariants").value = (item.variants || []).join("\n");
  $("#editAnswer").value = item.answer || "";
  $("#editEnabled").checked = item.enabled !== false;
  if (editorTab === "json") syncJsonEditorFromItem();
}

function clearItemEditor() {
  selectedItemId = "";
  $("#editId").value = "";
  $("#editQuestion").value = "";
  $("#editVariants").value = "";
  $("#editAnswer").value = "";
  $("#editEnabled").checked = true;
  syncJsonEditorFromItem();
}

async function loadMatchPrompt() {
  if (!selectedKbId) return;
  const cfg = await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}`);
  $("#editMatchPrompt").value = cfg.match_prompt || "";
  await refreshPromptPreview();
}

async function refreshPromptPreview() {
  if (!selectedKbId) {
    $("#editSystemPreview").value = "";
    return;
  }
  const data = await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/match-prompt-preview`);
  $("#editSystemPreview").value = data.system_prompt || "";
}

async function saveEditor() {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  try {
    if (editorTab === "json") {
      const raw = ($("#jsonEditor")?.value || "").trim();
      if (!raw) return showToast("JSON 为空", "error");
      const item = JSON.parse(raw);
      if (!item?.id) throw new Error("JSON 须包含 id 字段");
      const exists = (currentDoc.items || []).some((x) => x.id === item.id);
      const url = `/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions/items${exists ? `/${encodeURIComponent(item.id)}` : ""}`;
      await apiJson(url, {
        method: exists ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          question: item.question || "",
          variants: item.variants || [],
          answer: item.answer || "",
          enabled: item.enabled !== false,
        }),
      });
      selectedItemId = item.id;
    } else if (editorTab === "prompt") {
      await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match_prompt: $("#editMatchPrompt").value || "" }),
      });
      await refreshPromptPreview();
    } else {
      const payload = itemFromEditorFields();
      if (!payload?.id) return showToast("请选择或新建条目", "error");
      if (!payload.question) return showToast("标准问题不能为空", "error");
      const exists = (currentDoc.items || []).some((x) => x.id === payload.id);
      const url = `/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions/items${exists ? `/${encodeURIComponent(payload.id)}` : ""}`;
      await apiJson(url, {
        method: exists ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    await loadKbCache();
    await loadItems();
    if (selectedItemId) selectItem(selectedItemId);
    showToast("保存成功");
  } catch (e) {
    showToast(e.message || String(e), "error", 3200);
  }
}

function promptCreateKb() {
  showModal(
    "新增知识库",
    `<label class="fieldLabel">名称<input id="modalKbName" type="text" placeholder="知识库名称" /></label>`,
    async () => {
      const name = ($("#modalKbName")?.value || "").trim();
      if (!name) throw new Error("名称不能为空");
      const data = await apiJson("/knowledge-bases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await selectKb(data.kb_id);
      showToast("知识库已创建");
    }
  );
}

function promptRenameKb() {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  const cur = kbDisplayName(selectedKbId);
  showModal(
    "重命名知识库",
    `<label class="fieldLabel">名称<input id="modalKbRename" type="text" value="${escapeHtml(cur)}" /></label>`,
    async () => {
      const name = ($("#modalKbRename")?.value || "").trim();
      if (!name) throw new Error("名称不能为空");
      await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await loadKbCache();
      await refreshKbList();
      showToast("重命名成功");
    }
  );
}

async function deleteSelectedKb() {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  const name = kbDisplayName(selectedKbId);
  if (!confirm(`确定删除知识库「${name}」？此操作不可恢复。`)) return;
  try {
    await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}`, { method: "DELETE" });
    selectedKbId = "";
    selectedItemId = "";
    checkedItemIds.clear();
    await refreshKbList();
    await loadItems();
    clearItemEditor();
    showToast("知识库已删除");
    const first = Object.keys(kbCache)[0];
    if (first) await selectKb(first);
  } catch (e) {
    showToast(e.message || String(e), "error", 3200);
  }
}

async function reloadKbIndex() {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  try {
    const data = await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/reload`, { method: "POST" });
    await loadKbCache();
    await refreshKbList();
    showToast(`索引已重载（${data.enabled_count ?? 0} 题启用）`);
  } catch (e) {
    showToast(e.message || String(e), "error", 3200);
  }
}

function promptCreateItem() {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  showModal(
    "新增标准问题",
    `<label class="fieldLabel">ID<input id="modalItemId" type="text" placeholder="q004" /></label>
     <label class="fieldLabel">标准问题<textarea id="modalItemQ" rows="2"></textarea></label>`,
    async () => {
      const id = ($("#modalItemId")?.value || "").trim();
      const question = ($("#modalItemQ")?.value || "").trim();
      if (!id || !question) throw new Error("ID 与问题不能为空");
      await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, question, variants: [], answer: "待填写回答", enabled: true }),
      });
      await loadItems();
      selectItem(id);
      showToast("问题已新增");
    }
  );
}

function parseQuestionNum(id) {
  const m = /^q(\d+)$/i.exec(String(id || "").trim());
  return m ? parseInt(m[1], 10) : 0;
}

function formatQuestionId(n) {
  return `q${String(n).padStart(3, "0")}`;
}

function allocateQuestionId(occupied) {
  let max = 0;
  for (const it of currentDoc.items || []) {
    max = Math.max(max, parseQuestionNum(it.id));
  }
  for (const id of occupied) {
    max = Math.max(max, parseQuestionNum(id));
  }
  const next = formatQuestionId(max + 1);
  occupied.add(next);
  return next;
}

const BATCH_ADD_EXAMPLE = `[
  {
    "id": "q999",
    "question": "示例标准问题（id 可省略，将自动分配）",
    "variants": ["变体问法一", "变体问法二"],
    "answer": "Markdown 格式的回答内容",
    "enabled": true
  },
  {
    "question": "无 id 的条目会自动分配 q001、q002…",
    "variants": [],
    "answer": "待填写回答",
    "enabled": false
  }
]`;

function promptBatchCreateItems() {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  showModal(
    "批量新增问题",
    `<p style="margin:0 0 10px;color:var(--text-secondary);font-size:13px">粘贴 JSON 数组。每项须含 <code>question</code>；<code>id</code> 可省略（自动分配 q001 起）；可选 <code>variants</code>、<code>answer</code>、<code>enabled</code>。</p>
     <label class="fieldLabel"><textarea id="modalBatchJson" rows="12" spellcheck="false" class="jsonEditor">${BATCH_ADD_EXAMPLE}</textarea></label>`,
    async () => {
      const raw = ($("#modalBatchJson")?.value || "").trim();
      if (!raw) throw new Error("内容不能为空");
      const items = JSON.parse(raw);
      if (!Array.isArray(items) || !items.length) throw new Error("须为非空 JSON 数组");
      const occupied = new Set();
      let added = 0;
      let updated = 0;
      for (const item of items) {
        if (!item?.question) throw new Error(`无效条目（缺少 question）：${JSON.stringify(item)}`);
        let id = (item.id || "").trim();
        if (!id) id = allocateQuestionId(occupied);
        else {
          if (occupied.has(id)) throw new Error(`批次内 id 重复：${id}`);
          occupied.add(id);
        }
        const exists = (currentDoc.items || []).some((x) => x.id === id);
        const url = `/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions/items${exists ? `/${encodeURIComponent(id)}` : ""}`;
        await apiJson(url, {
          method: exists ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            question: item.question,
            variants: Array.isArray(item.variants) ? item.variants : [],
            answer: item.answer || "待填写回答",
            enabled: item.enabled !== false,
          }),
        });
        if (exists) updated += 1;
        else added += 1;
      }
      await loadKbCache();
      await loadItems();
      showToast(`批量完成：新增 ${added} 条，更新 ${updated} 条`);
    }
  );
}

function selectAllVisibleItems() {
  visibleItems().forEach((it) => checkedItemIds.add(it.id));
  renderItemList();
  showToast(`已全选 ${visibleItems().length} 条`);
}

function selectNoneItems() {
  checkedItemIds.clear();
  renderItemList();
  showToast("已取消全选");
}

function invertVisibleSelection() {
  visibleItems().forEach((it) => {
    if (checkedItemIds.has(it.id)) checkedItemIds.delete(it.id);
    else checkedItemIds.add(it.id);
  });
  renderItemList();
  showToast(`已选 ${checkedItemIds.size} 条`);
}

async function batchUpdateSelectedEnabled(enabled) {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  const ids = [...checkedItemIds];
  if (!ids.length) return showToast("请先勾选问题", "error");
  try {
    for (const id of ids) {
      const item = (currentDoc.items || []).find((x) => x.id === id);
      if (!item) continue;
      await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions/items/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          question: item.question,
          variants: item.variants || [],
          answer: item.answer || "",
          enabled,
        }),
      });
    }
    await loadKbCache();
    await loadItems();
    if (selectedItemId) selectItem(selectedItemId);
    showToast(enabled ? `已启用 ${ids.length} 条` : `已禁用 ${ids.length} 条`);
  } catch (e) {
    showToast(e.message || String(e), "error", 3200);
  }
}

async function deleteSelectedItems() {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  const ids = [...checkedItemIds];
  if (!ids.length) return showToast("请先勾选要删除的问题", "error");
  if (!confirm(`确定删除选中的 ${ids.length} 条问题？`)) return;
  try {
    for (const id of ids) {
      await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions/items/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    }
    checkedItemIds.clear();
    if (ids.includes(selectedItemId)) {
      selectedItemId = "";
      clearItemEditor();
    }
    await loadKbCache();
    await loadItems();
    showToast(`已删除 ${ids.length} 条`);
  } catch (e) {
    showToast(e.message || String(e), "error", 3200);
  }
}

async function refreshItemList() {
  if (!selectedKbId) return showToast("请先选择知识库", "error");
  await loadItems();
  if (selectedItemId) selectItem(selectedItemId);
  showToast("列表已刷新");
}

async function manageViewEnter() {
  await refreshKbList();
  if (!selectedKbId) {
    const first = Object.keys(kbCache)[0];
    if (first) await selectKb(first);
  }
}

function handleKbAction(action) {
  closeAllDropdowns();
  if (action === "add") promptCreateKb();
  else if (action === "refresh") refreshKbList().then(() => showToast("刷新成功"));
  else if (action === "rename") promptRenameKb();
  else if (action === "reload") reloadKbIndex();
  else if (action === "delete") deleteSelectedKb();
}

function handleItemAction(action) {
  closeAllDropdowns();
  if (action === "add") promptCreateItem();
  else if (action === "batchAdd") promptBatchCreateItems();
  else if (action === "refresh") refreshItemList();
  else if (action === "selectAll") selectAllVisibleItems();
  else if (action === "selectNone") selectNoneItems();
  else if (action === "invertSelect") invertVisibleSelection();
  else if (action === "enableSelected") batchUpdateSelectedEnabled(true);
  else if (action === "disableSelected") batchUpdateSelectedEnabled(false);
  else if (action === "deleteSelected") deleteSelectedItems();
}

document.addEventListener("DOMContentLoaded", () => {
  $$("[data-editor-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setEditorTab(btn.dataset.editorTab));
  });
  $("#editorSaveBtn")?.addEventListener("click", saveEditor);
  $("#itemSearch")?.addEventListener("input", renderItemList);
  $("#editMatchPrompt")?.addEventListener("blur", refreshPromptPreview);
  $$("[data-kb-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleKbAction(btn.dataset.kbAction));
  });
  $$("[data-item-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleItemAction(btn.dataset.itemAction));
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "s" && !$("#viewManage").classList.contains("hidden")) {
      e.preventDefault();
      saveEditor();
    }
  });
});
