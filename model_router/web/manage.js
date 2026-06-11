let manageSelectedAgentId = "";
let manageSelectedAgentIds = new Set();
let manageInitRunning = false;
const manageFileTreeRoot = "files";
let manageFileTreeData = [];
const manageFileTreeCollapsed = new Set();
let manageCtxTargetPath = "";
let manageEditorMode = "source";
const manageOpenFiles = new Map();
let manageActiveFile = "";

function manageLog(msg, kind = "info") {
  if (typeof appendLog === "function") appendLog(`[管理] ${msg}`, kind);
}

function getManageAgentDir(agentId = manageSelectedAgentId) {
  return agentId ? `${manageFileTreeRoot}/agent_${agentId}` : manageFileTreeRoot;
}

function updateManageFileRootLabel() {
  const label = $("#manageFileRootLabel");
  if (!label) return;
  label.textContent = manageSelectedAgentId
    ? `${manageFileTreeRoot}/ · agent_${manageSelectedAgentId}`
    : `${manageFileTreeRoot}/`;
}

function isPathUnderDir(filePath, dirPrefix) {
  return filePath === dirPrefix || filePath.startsWith(`${dirPrefix}/`);
}

function collectMdFilesInTree(nodes, dirPrefix) {
  const out = [];
  if (!nodes?.length) return out;
  for (const n of nodes) {
    if (
      n.type === "file" &&
      isPathUnderDir(n.path, dirPrefix) &&
      n.path.toLowerCase().endsWith(".md")
    ) {
      out.push(n.path);
    }
    if (n.type === "dir" && n.children?.length) {
      out.push(...collectMdFilesInTree(n.children, dirPrefix));
    }
  }
  return out;
}

function sortAgentMdPaths(paths) {
  return paths.sort((a, b) => {
    if (a.endsWith("/knowledge.md")) return -1;
    if (b.endsWith("/knowledge.md")) return 1;
    return a.localeCompare(b);
  });
}

function isTreeDirCollapsed(path) {
  return manageFileTreeCollapsed.has(path);
}

function toggleTreeDir(path) {
  if (manageFileTreeCollapsed.has(path)) manageFileTreeCollapsed.delete(path);
  else manageFileTreeCollapsed.add(path);
}

function expandTreePath(path) {
  if (!path) return;
  let cur = path;
  while (cur) {
    manageFileTreeCollapsed.delete(cur);
    const idx = cur.lastIndexOf("/");
    if (idx <= 0) break;
    cur = cur.substring(0, idx);
  }
}

function syncTreeBranchCollapse(branch) {
  if (!branch) return;
  const path = branch.dataset.path;
  const collapsed = isTreeDirCollapsed(path);
  branch.classList.toggle("collapsed", collapsed);
  const toggle = branch.querySelector(".treeDir .treeToggle:not(.spacer)");
  if (toggle) toggle.textContent = collapsed ? "▶" : "▾";
}

function applyTreeCollapseState() {
  $$("#fileTree .treeBranch").forEach((branch) => syncTreeBranchCollapse(branch));
}

function highlightAgentInTree(agentId) {
  expandTreePath(agentId ? getManageAgentDir(agentId) : "");
  applyTreeCollapseState();
  $$("#fileTree .treeDir, #fileTree .treeFile").forEach((el) => {
    el.classList.remove("agentHighlight");
  });
  if (!agentId) return;
  const agentDir = getManageAgentDir(agentId);
  let dir = null;
  for (const el of $$(`#fileTree .treeDir`)) {
    if (el.dataset.path === agentDir) {
      dir = el;
      break;
    }
  }
  if (dir) {
    dir.classList.add("agentHighlight");
    dir.scrollIntoView({ block: "nearest" });
  }
}

function isAllRouteAgentsSelected() {
  const ids = Object.keys(agentsCache || {});
  return ids.length > 0 && ids.every((id) => manageSelectedAgentIds.has(id));
}

function updateSelectAllAgentsBtn() {
  const btn = $("#selectAllAgentsBtn");
  if (!btn) return;
  btn.textContent = isAllRouteAgentsSelected() ? "取消全选" : "全选";
}

function toggleSelectAllRouteAgents() {
  if (isAllRouteAgentsSelected()) {
    manageSelectedAgentIds.clear();
  } else {
    manageSelectedAgentIds = new Set(Object.keys(agentsCache || {}));
  }
  renderRouteAgentGrid();
}

function getManageSelectedIds() {
  if (manageSelectedAgentIds.size) return Array.from(manageSelectedAgentIds);
  if (manageSelectedAgentId) return [manageSelectedAgentId];
  return [];
}

function renderRouteAgentGrid() {
  const box = $("#routeAgentGrid");
  if (!box) return;
  const entries = Object.entries(agentsCache || {}).sort((a, b) => {
    const ka = agentSortKey(a[0]);
    const kb = agentSortKey(b[0]);
    return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
  });

  if (!entries.length) {
    box.innerHTML = `<div class="empty">暂无 agent，点击「新增模型」创建。</div>`;
    updateSelectAllAgentsBtn();
    return;
  }

  box.innerHTML = entries
    .map(([id, cfg]) => {
      const status = cfg.status || "created";
      const statusClass = status === "initialized" ? "high" : "low";
      const selected = id === manageSelectedAgentId ? " selected" : "";
      const checked = manageSelectedAgentIds.has(id) ? " checked" : "";
      return `
        <div class="agentCard${selected}" data-agent-id="${escapeHtml(id)}">
          <label class="agentCardCheck" title="多选">
            <input type="checkbox" class="routeAgentCheck" value="${escapeHtml(id)}"${checked} />
          </label>
          <div class="agentCardBody">
            <div class="agentCardTitle">agent_${escapeHtml(id)}</div>
            ${cfg.name && cfg.name !== `agent_${id}` ? `<div class="agentCardSub">${escapeHtml(cfg.name)}</div>` : ""}
          </div>
          <div class="pill ${statusClass}"><strong>${escapeHtml(status)}</strong></div>
        </div>`;
    })
    .join("");

  box.querySelectorAll(".agentCard").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".agentCardCheck")) return;
      selectManageAgent(card.dataset.agentId);
    });
  });
  box.querySelectorAll(".routeAgentCheck").forEach((el) => {
    el.addEventListener("change", () => {
      if (el.checked) manageSelectedAgentIds.add(el.value);
      else manageSelectedAgentIds.delete(el.value);
      updateSelectAllAgentsBtn();
    });
  });
  updateSelectAllAgentsBtn();
}

function selectManageAgent(agentId) {
  manageSelectedAgentId = agentId;
  updateManageFileRootLabel();
  renderRouteAgentGrid();
  loadManageFileTree()
    .then(() => openAgentMdFiles(agentId))
    .catch((e) => manageLog(e?.message || e, "err"));
}

async function openAgentMdFiles(agentId) {
  const agentDir = getManageAgentDir(agentId);
  const mdFiles = sortAgentMdPaths(collectMdFilesInTree(manageFileTreeData, agentDir));
  if (mdFiles.length) {
    for (const path of mdFiles) {
      await openManageEditorFile(path);
    }
    return;
  }
  const fallback = `${agentDir}/knowledge.md`;
  try {
    await openManageEditorFile(fallback);
  } catch (e) {
    manageLog(`目录 ${agentDir} 下暂无 md 文件`, "warn");
  }
}

async function loadManageAgents() {
  const n = await loadAgentsCache();
  renderRouteAgentGrid();
  if (!manageSelectedAgentId && n > 0) {
    const first = Object.keys(agentsCache).sort((a, b) => {
      const ka = agentSortKey(a);
      const kb = agentSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
    })[0];
    if (first) selectManageAgent(first);
  }
  return n;
}

function renderFileTreeNodes(nodes, depth = 0) {
  if (!nodes?.length) return "";
  return nodes
    .map((n) => {
      const pad = depth * 14;
      if (n.type === "dir") {
        const hasChildren = n.children?.length > 0;
        const collapsed = isTreeDirCollapsed(n.path);
        const childrenHtml = hasChildren ? renderFileTreeNodes(n.children, depth + 1) : "";
        return `
          <div class="treeBranch${collapsed ? " collapsed" : ""}" data-path="${escapeHtml(n.path)}">
            <div class="treeDir" style="padding-left:${pad}px" data-path="${escapeHtml(n.path)}">
              ${
                hasChildren
                  ? `<span class="treeToggle" title="展开/收起">${collapsed ? "▶" : "▾"}</span>`
                  : `<span class="treeToggle spacer"></span>`
              }
              <span class="treeIcon">📁</span><span class="treeLabel">${escapeHtml(n.name)}</span>
            </div>
            ${hasChildren ? `<div class="treeChildren">${childrenHtml}</div>` : ""}
          </div>`;
      }
      return `
        <div class="treeFile" style="padding-left:${pad + 14}px" data-path="${escapeHtml(n.path)}">
          <span class="treeIcon">📄</span><span class="treeLabel">${escapeHtml(n.name)}</span>
        </div>`;
    })
    .join("");
}

function bindManageFileTreeEvents(box) {
  box.querySelectorAll(".treeFile").forEach((el) => {
    el.classList.toggle("active", el.dataset.path === manageActiveFile);
    el.addEventListener("click", () => openManageEditorFile(el.dataset.path));
    el.addEventListener("contextmenu", (e) => showContextMenu(e, el.dataset.path));
  });
  box.querySelectorAll(".treeDir").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      const branch = el.closest(".treeBranch");
      if (!branch?.querySelector(".treeChildren")) return;
      toggleTreeDir(el.dataset.path);
      syncTreeBranchCollapse(branch);
    });
    el.addEventListener("contextmenu", (e) => showContextMenu(e, el.dataset.path));
  });
}

async function loadManageFileTree() {
  const box = $("#fileTree");
  if (!box) return;
  box.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const data = await apiJson(`/files/tree?root=${encodeURIComponent(manageFileTreeRoot)}`);
    manageFileTreeData = data.tree || [];
    if (!manageFileTreeData.length) {
      box.innerHTML = `<div class="empty" style="padding:8px">空目录</div>`;
      return;
    }
    box.innerHTML = renderFileTreeNodes(manageFileTreeData);
    bindManageFileTreeEvents(box);
    highlightAgentInTree(manageSelectedAgentId);
  } catch (e) {
    manageFileTreeData = [];
    box.innerHTML = `<div class="empty">加载失败：${escapeHtml(e?.message || e)}</div>`;
  }
}

function showContextMenu(e, path) {
  e.preventDefault();
  manageCtxTargetPath = path;
  const menu = $("#contextMenu");
  if (!menu) return;
  menu.classList.remove("hidden");
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
}

function hideContextMenu() {
  $("#contextMenu")?.classList.add("hidden");
}

function renderEditorTabs() {
  const bar = $("#editorTabs");
  if (!bar) return;
  bar.innerHTML = Array.from(manageOpenFiles.entries())
    .map(
      ([path, st]) =>
        `<button type="button" class="editorTab${path === manageActiveFile ? " active" : ""}${
          st.dirty ? " dirty" : ""
        }" data-file="${escapeHtml(path)}">${escapeHtml(path.split("/").pop() || path)}</button>`
    )
    .join("");
  bar.querySelectorAll(".editorTab").forEach((btn) => {
    btn.addEventListener("click", () => switchManageEditorTab(btn.dataset.file));
  });
}

function switchManageEditorTab(path) {
  if (path === manageActiveFile) return;
  const cur = manageOpenFiles.get(manageActiveFile);
  const ta = $("#editorTextarea");
  if (cur && ta) cur.text = ta.value;
  manageActiveFile = path;
  const st = manageOpenFiles.get(path);
  if (ta) ta.value = st?.text ?? "";
  renderEditorTabs();
  renderManageEditorView();
}

function renderManageEditorView() {
  const ta = $("#editorTextarea");
  const preview = $("#editorPreviewBox");
  const st = manageOpenFiles.get(manageActiveFile);
  if (!st) {
    if (ta) {
      ta.value = "";
      ta.classList.remove("hidden");
    }
    if (preview) {
      preview.classList.add("hidden");
      preview.innerHTML = `<div class="empty">选择左侧文件进行编辑</div>`;
    }
    return;
  }
  if (manageEditorMode === "preview" && manageActiveFile.toLowerCase().endsWith(".md")) {
    ta?.classList.add("hidden");
    preview?.classList.remove("hidden");
    if (preview && typeof renderMarkdownPreview === "function") {
      preview.innerHTML = renderMarkdownPreview(st.text, manageActiveFile);
    } else if (preview) {
      preview.innerHTML = `<pre>${escapeHtml(st.text)}</pre>`;
    }
  } else {
    preview?.classList.add("hidden");
    ta?.classList.remove("hidden");
    if (ta) ta.value = st.text;
  }
}

async function openManageEditorFile(path) {
  if (!path) return;
  if (manageOpenFiles.has(path)) {
    switchManageEditorTab(path);
    return;
  }
  const data = await apiJson(`/files/raw?file=${encodeURIComponent(path)}`);
  manageOpenFiles.set(path, { text: data.text || "", dirty: false });
  manageActiveFile = path;
  renderEditorTabs();
  renderManageEditorView();
  $$("#fileTree .treeFile").forEach((el) => {
    el.classList.toggle("active", el.dataset.path === path);
  });
  expandTreePath(path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : manageFileTreeRoot);
  applyTreeCollapseState();
}

async function saveManageActiveFile() {
  if (!manageActiveFile) return;
  const ta = $("#editorTextarea");
  const st = manageOpenFiles.get(manageActiveFile);
  if (!st) return;
  if (ta && manageEditorMode === "source") st.text = ta.value;
  await apiJson("/files/raw", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: manageActiveFile, text: st.text }),
  });
  st.dirty = false;
  manageLog(`已保存 ${manageActiveFile}`, "ok");
  renderEditorTabs();
}

async function createManageAgent() {
  const data = await apiJson("/agents/auto", { method: "POST" });
  manageLog(`已创建 agent_${data.agent_id}`, "ok");
  await loadManageAgents();
  selectManageAgent(data.agent_id);
  refreshTestPageSideData();
  refreshBatchFileList();
}

async function initManageAgents(ids) {
  if (!ids.length) {
    manageLog("未选择 agent", "warn");
    return;
  }
  if (manageInitRunning) return;
  manageInitRunning = true;
  $("#manageSelectedBtn").disabled = true;
  try {
    for (const id of ids) {
      manageLog(`初始化 agent ${id}…`);
      await apiJson(`/agents/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      manageLog(`agent ${id} 初始化完成`, "ok");
    }
    await loadManageAgents();
    refreshTestPageSideData();
  } catch (e) {
    manageLog(`初始化失败：${e?.message || e}`, "err");
  } finally {
    manageInitRunning = false;
    $("#manageSelectedBtn").disabled = false;
  }
}

async function deleteManageAgents(ids) {
  for (const id of ids) {
    if (!confirm(`确定删除 agent_${id} 及其文件夹？`)) continue;
    await apiJson(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
    manageLog(`已删除 agent_${id}`, "ok");
    manageSelectedAgentIds.delete(id);
    if (manageSelectedAgentId === id) manageSelectedAgentId = "";
  }
  await loadManageAgents();
  await loadManageFileTree();
  refreshTestPageSideData();
  refreshBatchFileList();
}

async function renameManageAgent(id) {
  const newId = prompt(`重命名 agent_${id}，输入新 id（仅数字/标识）：`, id);
  if (!newId || newId === id) return;
  await apiJson(`/agents/${encodeURIComponent(id)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_agent_id: newId.trim() }),
  });
  manageLog(`agent_${id} → agent_${newId.trim()}`, "ok");
  if (manageSelectedAgentId === id) manageSelectedAgentId = newId.trim();
  await loadManageAgents();
  selectManageAgent(newId.trim());
  refreshTestPageSideData();
  refreshBatchFileList();
}

async function handleManageAgentAction(action) {
  hideManageAgentMenu();
  const ids = getManageSelectedIds();
  if (action === "init") return initManageAgents(ids);
  if (action === "delete") return deleteManageAgents(ids);
  if (action === "rename") {
    if (ids.length !== 1) {
      manageLog("重命名请只选择一个 agent", "warn");
      return;
    }
    return renameManageAgent(ids[0]);
  }
}

function toggleManageAgentMenu() {
  $("#manageAgentMenu")?.classList.toggle("hidden");
}

function hideManageAgentMenu() {
  $("#manageAgentMenu")?.classList.add("hidden");
}

async function handleContextAction(action) {
  hideContextMenu();
  const path = manageCtxTargetPath;
  if (!path) return;
  if (action === "new") {
    const name = prompt("新建文件名（如 notes.md）：", "notes.md");
    if (!name) return;
    let parent = manageCtxTargetPath || getManageAgentDir() || manageFileTreeRoot;
    try {
      const info = await apiJson(`/files/raw?file=${encodeURIComponent(path)}`);
      void info;
      parent = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : parent;
    } catch (e) {
      parent = path.includes(".") ? path.substring(0, path.lastIndexOf("/")) : path || parent;
    }
    const filePath = `${parent}/${name}`.replace(/\/+/g, "/");
    await apiJson("/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: filePath }),
    });
    await loadManageFileTree();
    await openManageEditorFile(filePath);
    return;
  }
  if (action === "rename") {
    const newName = prompt("新路径（相对 files/）：", path);
    if (!newName || newName === path) return;
    await apiJson("/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: path, to: newName }),
    });
    if (manageOpenFiles.has(path)) {
      const st = manageOpenFiles.get(path);
      manageOpenFiles.delete(path);
      manageOpenFiles.set(newName, st);
      if (manageActiveFile === path) manageActiveFile = newName;
    }
    await loadManageFileTree();
    renderEditorTabs();
    return;
  }
  if (action === "delete") {
    if (!confirm(`删除文件 ${path}？`)) return;
    await apiJson(`/files?file=${encodeURIComponent(path)}`, { method: "DELETE" });
    manageOpenFiles.delete(path);
    if (manageActiveFile === path) manageActiveFile = "";
    await loadManageFileTree();
    renderEditorTabs();
    renderManageEditorView();
  }
}

function bindManage() {
  $("#addAgentBtn")?.addEventListener("click", () => {
    createManageAgent().catch((e) => manageLog(e?.message || e, "err"));
  });
  $("#selectAllAgentsBtn")?.addEventListener("click", toggleSelectAllRouteAgents);
  $("#reloadAgentsBtn")?.addEventListener("click", () => {
    loadManageAgents()
      .then((n) => manageLog(`已刷新 ${n} 个 agent`, "ok"))
      .catch((e) => manageLog(e?.message || e, "err"));
  });
  $("#manageSelectedBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleManageAgentMenu();
  });
  $$("#manageAgentMenu [data-manage-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      handleManageAgentAction(btn.dataset.manageAction).catch((e) =>
        manageLog(e?.message || e, "err")
      );
    });
  });
  $("#editorSaveBtn")?.addEventListener("click", () => {
    saveManageActiveFile().catch((e) => manageLog(e?.message || e, "err"));
  });
  $("#editorPreviewBtn")?.addEventListener("click", () => {
    manageEditorMode = manageEditorMode === "preview" ? "source" : "preview";
    $("#editorPreviewBtn").classList.toggle("primary", manageEditorMode === "preview");
    renderManageEditorView();
  });
  $("#editorTextarea")?.addEventListener("input", () => {
    const st = manageOpenFiles.get(manageActiveFile);
    if (st) st.dirty = true;
    renderEditorTabs();
  });
  document.addEventListener("click", () => {
    hideContextMenu();
    hideManageAgentMenu();
  });
  $$("#contextMenu [data-ctx]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleContextAction(btn.dataset.ctx).catch((err) => manageLog(err?.message || err, "err"));
    });
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s" && !$("#viewManage").classList.contains("hidden")) {
      e.preventDefault();
      saveManageActiveFile().catch((err) => manageLog(err?.message || err, "err"));
    }
  });
}

function manageViewEnter() {
  updateManageFileRootLabel();
  loadManageAgents().catch((e) => manageLog(e?.message || e, "err"));
}

bindManage();
