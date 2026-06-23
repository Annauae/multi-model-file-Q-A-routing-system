let selectedKbId = "";
let selectedItemId = "";
let currentDoc = { version: 1, items: [] };
let editorTab = "item";

function setEditorTab(name) {
  editorTab = name;
  $$("[data-editor-tab]").forEach((b) => b.classList.toggle("active", b.dataset.editorTab === name));
  $$("#editorTabItem,#editorTabJson,#editorTabPrompt").forEach((p) => p.classList.remove("active"));
  const pane = $(`#editorTab${name.charAt(0).toUpperCase()}${name.slice(1)}`);
  pane?.classList.add("active");
  if (name === "prompt") refreshPromptPreview();
}

async function refreshKbList() {
  await loadKbCache();
  const list = $("#kbList");
  const ids = Object.keys(kbCache).sort((a, b) => Number(a) - Number(b));
  list.innerHTML = ids.length
    ? ids
        .map(
          (id) =>
            `<div class="listItem ${id === selectedKbId ? "active" : ""}" data-kb-id="${escapeHtml(id)}"><div>${escapeHtml(kbDisplayName(id))}</div><div class="sub">kb_${escapeHtml(id)} · ${kbCache[id].enabled_count ?? 0} 题</div></div>`
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
  await refreshKbList();
  await loadItems();
  clearItemEditor();
  await loadJsonEditor();
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

function renderItemList() {
  const q = ($("#itemSearch")?.value || "").trim().toLowerCase();
  const items = (currentDoc.items || []).filter((it) => {
    if (!q) return true;
    const hay = [it.id, it.question, ...(it.variants || [])].join(" ").toLowerCase();
    return hay.includes(q);
  });
  const list = $("#itemList");
  list.innerHTML = items.length
    ? items
        .map(
          (it) =>
            `<div class="listItem ${it.id === selectedItemId ? "active" : ""}" data-item-id="${escapeHtml(it.id)}"><div>${escapeHtml(it.question)}</div><div class="sub">${escapeHtml(it.id)}${it.enabled === false ? " · 已禁用" : ""}</div></div>`
        )
        .join("")
    : `<div class="empty">无条目</div>`;
  list.querySelectorAll(".listItem[data-item-id]").forEach((el) => {
    el.addEventListener("click", () => selectItem(el.dataset.itemId));
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
}

function clearItemEditor() {
  selectedItemId = "";
  $("#editId").value = "";
  $("#editQuestion").value = "";
  $("#editVariants").value = "";
  $("#editAnswer").value = "";
  $("#editEnabled").checked = true;
}

async function loadJsonEditor() {
  if (!selectedKbId) {
    $("#jsonEditor").value = "";
    return;
  }
  currentDoc = await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions`);
  $("#jsonEditor").value = JSON.stringify(currentDoc, null, 2);
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
  if (!selectedKbId) return alert("请选择知识库");
  try {
    if (editorTab === "json") {
      const doc = JSON.parse($("#jsonEditor").value || "{}");
      await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
    } else if (editorTab === "prompt") {
      await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match_prompt: $("#editMatchPrompt").value || "" }),
      });
      await refreshPromptPreview();
    } else {
      const id = ($("#editId").value || "").trim();
      if (!id) return alert("请选择或新建条目");
      const payload = {
        id,
        question: ($("#editQuestion").value || "").trim(),
        variants: ($("#editVariants").value || "").split("\n").map((s) => s.trim()).filter(Boolean),
        answer: $("#editAnswer").value || "",
        enabled: $("#editEnabled").checked,
      };
      const exists = (currentDoc.items || []).some((x) => x.id === id);
      const url = `/knowledge-bases/${encodeURIComponent(selectedKbId)}/questions/items${exists ? `/${encodeURIComponent(id)}` : ""}`;
      await apiJson(url, {
        method: exists ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    await loadKbCache();
    await loadItems();
    await loadJsonEditor();
    if (selectedItemId) selectItem(selectedItemId);
    alert("保存成功");
  } catch (e) {
    alert(e.message || e);
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
    }
  );
}

function promptCreateItem() {
  if (!selectedKbId) return alert("请先选择知识库");
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
    }
  );
}

async function manageViewEnter() {
  await refreshKbList();
  if (!selectedKbId) {
    const first = Object.keys(kbCache)[0];
    if (first) await selectKb(first);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $$("[data-editor-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setEditorTab(btn.dataset.editorTab));
  });
  $("#editorSaveBtn")?.addEventListener("click", saveEditor);
  $("#kbAddBtn")?.addEventListener("click", promptCreateKb);
  $("#kbRefreshBtn")?.addEventListener("click", refreshKbList);
  $("#itemAddBtn")?.addEventListener("click", promptCreateItem);
  $("#itemSearch")?.addEventListener("input", renderItemList);
  $("#editMatchPrompt")?.addEventListener("blur", refreshPromptPreview);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "s" && !$("#viewManage").classList.contains("hidden")) {
      e.preventDefault();
      saveEditor();
    }
  });
});
