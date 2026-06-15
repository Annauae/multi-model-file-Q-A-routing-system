let manageSelectedRouterId = "";
let manageSelectedSubAgentId = "";
let manageFocus = "router";
let manageSplitRanges = [];
let manageEditorMode = "source";
const manageOpenFiles = new Map();
let manageActiveFile = "";
let manageInitRunning = false;
const manageSubAgentChecked = new Set();
let manageSubSelectMode = false;

function manageLog(msg, kind = "info") {
  if (typeof appendLog === "function") appendLog(`[管理] ${msg}`, kind);
}

function getManageAgentDir(agentId) {
  if (!agentId || !manageSelectedRouterId) return "";
  return `files/router_${manageSelectedRouterId}/agent_${agentId}`;
}

function agentApiUrl(path) {
  if (!manageSelectedRouterId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}router_id=${encodeURIComponent(manageSelectedRouterId)}`;
}

function subAgentsForCurrentRouter() {
  if (!manageSelectedRouterId) return {};
  return agentsForRouter(manageSelectedRouterId);
}

function getSubAgentCheckedIds() {
  return Array.from(manageSubAgentChecked);
}

function closeAllManageDropdowns() {
  $$("#viewManage .dropdownMenu").forEach((m) => {
    m.classList.add("hidden");
    m.style.position = "";
    m.style.top = "";
    m.style.left = "";
    m.style.right = "";
    m.style.zIndex = "";
  });
}

function toggleManageDropdown(toggleBtn) {
  const box = toggleBtn?.closest(".headDropdown");
  const menu = box?.querySelector(".dropdownMenu");
  if (!menu) return;
  const willOpen = menu.classList.contains("hidden");
  closeAllManageDropdowns();
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

function updateSubSelectToggleLabel() {
  const btn = document.querySelector('[data-sub-action="toggleSelect"]');
  if (!btn) return;
  btn.textContent = manageSubSelectMode ? "关闭多选" : "多选模式";
  btn.classList.toggle("activeToggle", manageSubSelectMode);
}

function toggleSubSelectMode() {
  manageSubSelectMode = !manageSubSelectMode;
  if (!manageSubSelectMode) manageSubAgentChecked.clear();
  renderSubAgentList();
  updateSubSelectToggleLabel();
  manageLog(manageSubSelectMode ? "已开启子 Agent 多选模式" : "已关闭多选模式", "info");
}

function selectAllSubAgents() {
  manageSubSelectMode = true;
  manageSubAgentChecked.clear();
  for (const id of Object.keys(subAgentsForCurrentRouter())) {
    manageSubAgentChecked.add(id);
  }
  renderSubAgentList();
  updateSubSelectToggleLabel();
  manageLog(`已全选 ${manageSubAgentChecked.size} 个子 Agent`, "info");
}

function deselectAllSubAgents() {
  manageSubAgentChecked.clear();
  renderSubAgentList();
  manageLog("已取消全选", "info");
}

function currentRouterCfg() {
  return routersCache[manageSelectedRouterId] || {};
}

async function refreshSubAgentsOnly() {
  await reloadManageData();
  manageLog("子 Agent 列表已刷新", "ok");
}

async function manageViewEnter() {
  await loadAllCaches();
  if (!manageSelectedRouterId && Object.keys(routersCache).length) {
    manageSelectedRouterId = Object.keys(routersCache).sort()[0];
  }
  syncSplitRangesFromRouter();
  renderRouterList();
  renderSubAgentList();
  updateMainPanes();
  loadPromptEditor();
}

async function reloadManageData() {
  await loadAllCaches();
  syncSplitRangesFromRouter();
  renderRouterList();
  renderSubAgentList();
  updateMainPanes();
  loadPromptEditor();
  populateRouterSelect($("#routerSelect"), manageSelectedRouterId);
  populateRouterSelect($("#batchRouterSelect"), manageSelectedRouterId);
}

function syncSplitRangesFromRouter() {
  const ranges = currentRouterCfg().split_ranges || [];
  manageSplitRanges = ranges.map((r) => [Number(r[0]), Number(r[1])]).filter((r) => r[0] > 0 && r[1] >= r[0]);
  if (!manageSplitRanges.length) manageSplitRanges = [[1, 3]];
  renderSplitRanges();
  const files = currentRouterCfg().source_files || [];
  const label = $("#routerSourceLabel");
  if (label) label.textContent = files.length ? `源文件: ${files[files.length - 1]}` : "尚未上传源文件";
}

function renderRouterList() {
  const box = $("#routerList");
  if (!box) return;
  const entries = Object.entries(routersCache || {}).sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]));
  if (!entries.length) {
    box.innerHTML = `<div class="empty">暂无总 Agent，点击「新增」。</div>`;
    return;
  }
  box.innerHTML = entries
    .map(([id, cfg]) => {
      const active = id === manageSelectedRouterId ? " active" : "";
      const name = routerDisplayName(id, cfg);
      return `<button type="button" class="manageListItem${active}" data-router-id="${escapeHtml(id)}">${escapeHtml(name)}</button>`;
    })
    .join("");
  box.querySelectorAll("[data-router-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectRouter(btn.dataset.routerId));
  });
}

function renderSubAgentList() {
  const box = $("#subAgentList");
  if (!box) return;
  if (!manageSelectedRouterId) {
    box.innerHTML = `<div class="empty">请先选择总 Agent。</div>`;
    return;
  }
  const agents = agentsForRouter(manageSelectedRouterId);
  const entries = Object.entries(agents).sort((a, b) => {
    const ka = agentSortKey(a[0]);
    const kb = agentSortKey(b[0]);
    return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
  });
  if (!entries.length) {
    box.innerHTML = `<div class="empty">暂无子 Agent。</div>`;
    return;
  }
  box.innerHTML = entries
    .map(([id, cfg]) => {
      const active = id === manageSelectedSubAgentId ? " active" : "";
      const status = cfg.status || "created";
      const checked = manageSubAgentChecked.has(id) ? " checked" : "";
      const checkHtml =
        manageSubSelectMode
          ? `<label class="manageSubCheck"><input type="checkbox" class="subAgentCheckInput" value="${escapeHtml(id)}"${checked} /></label>`
          : "";
      return `<button type="button" class="manageListItem withSubCheck${active}" data-sub-id="${escapeHtml(id)}">
        ${checkHtml}
        <span class="manageSubLabel">${escapeHtml(subAgentDisplayName(id, cfg))}</span>
        <span class="pill ${status === "initialized" ? "high" : "low"}">${escapeHtml(status)}</span>
      </button>`;
    })
    .join("");
  box.querySelectorAll(".subAgentCheckInput").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("change", (e) => {
      const id = e.target.value;
      if (e.target.checked) manageSubAgentChecked.add(id);
      else manageSubAgentChecked.delete(id);
    });
  });
  box.querySelectorAll("[data-sub-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (e.target.closest(".manageSubCheck")) return;
      selectSubAgent(btn.dataset.subId);
    });
  });
}

function selectRouter(routerId) {
  manageSelectedRouterId = routerId;
  manageSelectedSubAgentId = "";
  manageSubAgentChecked.clear();
  manageFocus = "router";
  syncSplitRangesFromRouter();
  renderRouterList();
  renderSubAgentList();
  updateMainPanes();
  loadPromptEditor();
}

function selectSubAgent(agentId) {
  manageSelectedSubAgentId = agentId;
  manageFocus = "subagent";
  renderSubAgentList();
  updateMainPanes();
  loadPromptEditor();
  openSubAgentMd(agentId).catch((e) => manageLog(e?.message || e, "err"));
}

function updateMainPanes() {
  const routerPane = $("#routerOpsPane");
  const subPane = $("#subMdPane");
  const title = $("#promptPaneTitle");
  if (manageFocus === "subagent" && manageSelectedSubAgentId) {
    routerPane?.classList.add("hidden");
    subPane?.classList.remove("hidden");
    if (title) title.textContent = "子 Agent 提示词";
  } else {
    routerPane?.classList.remove("hidden");
    subPane?.classList.add("hidden");
    if (title) title.textContent = "总 Agent 路由提示词";
  }
}

function syncSplitRangesFromDom() {
  const rows = Array.from($$("#splitRangesList .splitRangeRow"));
  if (!rows.length) return;
  manageSplitRanges = rows.map((row) => {
    const s = Number(row.querySelector(".splitStart")?.value);
    const e = Number(row.querySelector(".splitEnd")?.value);
    return [s > 0 ? s : 1, e > 0 ? e : 1];
  });
}

function addSplitRangeRow() {
  if (!manageSelectedRouterId) {
    manageLog("请先在左侧选择总 Agent", "warn");
    return;
  }
  syncSplitRangesFromDom();
  if (!manageSplitRanges.length) {
    manageSplitRanges = [[1, 3]];
  }
  const last = manageSplitRanges[manageSplitRanges.length - 1];
  const prevEnd = Array.isArray(last) ? Number(last[1]) : 0;
  const start = prevEnd > 0 ? prevEnd + 1 : 1;
  manageSplitRanges.push([start, start + 2]);
  renderSplitRanges();
  const list = $("#splitRangesList");
  list?.lastElementChild?.scrollIntoView?.({ block: "nearest" });
}

function removeSplitRangeRow(row) {
  if (!row) return;
  syncSplitRangesFromDom();
  const idx = Number(row.dataset.idx);
  if (Number.isFinite(idx) && idx >= 0) {
    manageSplitRanges.splice(idx, 1);
  }
  if (!manageSplitRanges.length) manageSplitRanges = [[1, 3]];
  renderSplitRanges();
}

function renderSplitRanges() {
  const box = $("#splitRangesList");
  if (!box) return;
  box.innerHTML = manageSplitRanges
    .map(
      (r, i) => `
    <div class="splitRangeRow" data-idx="${i}">
      <input type="number" class="splitStart" min="1" value="${r[0]}" />
      <span>-</span>
      <input type="number" class="splitEnd" min="1" value="${r[1]}" />
      <button type="button" class="btn ghost btnXs removeRangeBtn">×</button>
    </div>`
    )
    .join("");
}

function collectSplitRanges() {
  const rows = $$("#splitRangesList .splitRangeRow");
  const out = [];
  rows.forEach((row) => {
    const s = Number(row.querySelector(".splitStart")?.value);
    const e = Number(row.querySelector(".splitEnd")?.value);
    if (s > 0 && e >= s) out.push([s, e]);
  });
  return out;
}

async function saveSplitRangesToServer() {
  if (!manageSelectedRouterId) return;
  const ranges = collectSplitRanges();
  await apiJson(`/routers/${encodeURIComponent(manageSelectedRouterId)}/split-ranges`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ split_ranges: ranges }),
  });
  manageSplitRanges = ranges.length ? ranges : [[1, 3]];
  renderSplitRanges();
  await loadRoutersCache();
}

async function loadPromptEditor() {
  const ta = $("#promptEditor");
  if (!ta) return;
  delete ta.dataset.defaultTemplate;
  delete ta.dataset.isDefault;
  try {
    if (manageFocus === "subagent" && manageSelectedSubAgentId) {
      const data = await apiJson(agentApiUrl(`/agents/${encodeURIComponent(manageSelectedSubAgentId)}/prompt-template`));
      ta.value = data.display_text || "";
      ta.dataset.defaultTemplate = data.default_template || "";
      ta.dataset.isDefault = data.is_default ? "1" : "0";
    } else if (manageSelectedRouterId) {
      const custom = (currentRouterCfg().router_prompt || "").trim();
      if (custom) {
        ta.value = custom;
        ta.dataset.isDefault = "0";
      } else {
        const data = await apiJson("/routers/default-prompt");
        ta.value = data.prompt || "";
        ta.dataset.isDefault = "1";
      }
    } else {
      ta.value = "";
    }
  } catch (e) {
    manageLog(`加载提示词失败：${e?.message || e}`, "err");
  }
}

async function savePromptEditor() {
  const ta = $("#promptEditor");
  if (!ta) return;
  const text = (ta.value || "").trim();
  if (manageFocus === "subagent" && manageSelectedSubAgentId) {
    const defaultTpl = (ta.dataset.defaultTemplate || "").trim();
    const instructions = defaultTpl && text === defaultTpl ? "" : ta.value;
    await apiJson(agentApiUrl(`/agents/${encodeURIComponent(manageSelectedSubAgentId)}/instructions`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer_instructions: instructions }),
    });
    await loadAgentsCache();
    await loadPromptEditor();
    manageLog("子 Agent 提示词已保存", "ok");
  } else if (manageSelectedRouterId) {
    let routerPrompt = ta.value;
    if (ta.dataset.isDefault === "1") {
      const data = await apiJson("/routers/default-prompt");
      if (text === (data.prompt || "").trim()) routerPrompt = "";
    }
    await apiJson(`/routers/${encodeURIComponent(manageSelectedRouterId)}/prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ router_prompt: routerPrompt }),
    });
    await loadRoutersCache();
    await loadPromptEditor();
    manageLog("总 Agent 路由提示词已保存", "ok");
  }
}

async function createRouter() {
  const data = await apiJson("/routers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  manageSelectedRouterId = data.router_id;
  manageFocus = "router";
  await reloadManageData();
  manageLog(`已创建 ${routerDisplayName(data.router_id, data.router)}`, "ok");
}

async function renameRouter() {
  if (!manageSelectedRouterId) return;
  const cur = routerDisplayName(manageSelectedRouterId);
  const name = prompt("输入新的展示名称：", cur);
  if (!name || name === cur) return;
  await apiJson(`/routers/${encodeURIComponent(manageSelectedRouterId)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  await reloadManageData();
  manageLog("总 Agent 已重命名", "ok");
}

async function deleteRouter() {
  if (!manageSelectedRouterId) return;
  const name = routerDisplayName(manageSelectedRouterId);
  if (!confirm(`确定删除「${name}」及其所有子 Agent？`)) return;
  await apiJson(`/routers/${encodeURIComponent(manageSelectedRouterId)}`, { method: "DELETE" });
  manageSelectedRouterId = "";
  manageSelectedSubAgentId = "";
  await reloadManageData();
  refreshTestPageSideData();
  manageLog("总 Agent 已删除", "ok");
}

async function createSubAgent() {
  if (!manageSelectedRouterId) {
    manageLog("请先选择总 Agent", "warn");
    return;
  }
  const data = await apiJson(`/routers/${encodeURIComponent(manageSelectedRouterId)}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  await reloadManageData();
  selectSubAgent(data.agent_id);
  manageLog(`已创建子 Agent ${data.agent_id}`, "ok");
}

async function initSubAgent(agentId) {
  const id = (agentId || manageSelectedSubAgentId || "").trim();
  if (!id) {
    manageLog("请先选择子 Agent", "warn");
    return;
  }
  if (manageInitRunning) return;
  manageInitRunning = true;
  try {
    manageLog(`初始化 agent ${id}…`);
    await apiJson(agentApiUrl(`/agents/${encodeURIComponent(id)}/refresh`), { method: "POST" });
    await reloadManageData();
    refreshTestPageSideData();
    manageLog(`agent ${id} 初始化完成`, "ok");
  } catch (e) {
    manageLog(`初始化失败：${e?.message || e}`, "err");
  } finally {
    manageInitRunning = false;
  }
}

async function initSubAgentsBatch(agentIds) {
  const ids = [...new Set((agentIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!ids.length) {
    manageLog("没有可初始化的子 Agent", "warn");
    return;
  }
  if (manageInitRunning) return;
  manageInitRunning = true;
  let ok = 0;
  let fail = 0;
  try {
    manageLog(`开始批量初始化 ${ids.length} 个子 Agent…`);
    for (const id of ids) {
      try {
        manageLog(`→ 初始化 agent ${id}…`);
        await apiJson(agentApiUrl(`/agents/${encodeURIComponent(id)}/refresh`), { method: "POST" });
        ok++;
      } catch (e) {
        fail++;
        manageLog(`agent ${id} 失败：${e?.message || e}`, "err");
      }
    }
    await reloadManageData();
    refreshTestPageSideData();
    manageLog(`批量初始化完成：成功 ${ok}，失败 ${fail}`, fail ? "warn" : "ok");
  } finally {
    manageInitRunning = false;
  }
}

async function initSelectedSubAgents() {
  const ids = getSubAgentCheckedIds();
  if (!ids.length) {
    manageLog("请先在多选模式下勾选子 Agent", "warn");
    return;
  }
  await initSubAgentsBatch(ids);
}

async function initAllSubAgents() {
  const ids = Object.keys(subAgentsForCurrentRouter());
  if (!ids.length) {
    manageLog("当前总 Agent 下没有子 Agent", "warn");
    return;
  }
  if (!confirm(`确定初始化全部 ${ids.length} 个子 Agent？耗时可能较长。`)) return;
  await initSubAgentsBatch(ids);
}

async function renameSubAgent() {
  if (!manageSelectedSubAgentId) return;
  const cur = manageSelectedSubAgentId;
  const cfg = agentsCache[cur] || {};
  const curLabel = subAgentDisplayName(cur, cfg);
  const name = prompt("输入新的展示名称：", curLabel);
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === curLabel) return;
  await apiJson(agentApiUrl(`/agents/${encodeURIComponent(cur)}/rename-display`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: trimmed }),
  });
  await reloadManageData();
  selectSubAgent(cur);
  manageLog(`子 Agent 已重命名为「${trimmed}」`, "ok");
}

async function deleteSubAgent() {
  if (!manageSelectedSubAgentId) return;
  const cfg = agentsCache[manageSelectedSubAgentId] || {};
  const label = cfg.name || `agent_${manageSelectedSubAgentId}`;
  if (!confirm(`确定删除子 Agent「${label}」（ID: ${manageSelectedSubAgentId}）？`)) return;
  await apiJson(agentApiUrl(`/agents/${encodeURIComponent(manageSelectedSubAgentId)}`), { method: "DELETE" });
  manageSelectedSubAgentId = "";
  manageFocus = "router";
  await reloadManageData();
  refreshTestPageSideData();
  manageLog("子 Agent 已删除", "ok");
}

async function uploadRouterFile(file) {
  if (!manageSelectedRouterId || !file) return;
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`/routers/${encodeURIComponent(manageSelectedRouterId)}/upload`, {
    method: "POST",
    body: fd,
  });
  const txt = await r.text();
  let data = null;
  try {
    data = JSON.parse(txt);
  } catch (e) {
    if (!r.ok) throw new Error(txt || r.statusText);
  }
  if (!r.ok) throw new Error(data?.detail || txt || r.statusText);
  await loadRoutersCache();
  syncSplitRangesFromRouter();
  manageLog(`已上传 ${data.file}`, "ok");
}

function setSplitProgress(text, { visible = true } = {}) {
  const box = $("#splitProgressBox");
  const el = $("#splitProgressText");
  if (!box || !el) return;
  box.classList.toggle("hidden", !visible);
  if (text != null) el.textContent = text;
}

function appendSplitProgress(line) {
  const el = $("#splitProgressText");
  const box = $("#splitProgressBox");
  if (!el || !box) return;
  box.classList.remove("hidden");
  const prev = (el.textContent || "").trim();
  el.textContent = prev && prev !== "—" ? `${prev}\n${line}` : line;
}

async function runSplit() {
  if (!manageSelectedRouterId) return;
  const ranges = collectSplitRanges();
  if (!ranges.length) {
    manageLog("请至少添加一组页码范围", "warn");
    return;
  }
  await saveSplitRangesToServer();
  const cfg = currentRouterCfg();
  const source = (cfg.source_files || []).slice(-1)[0] || "";
  if (!source) {
    manageLog("请先上传 PDF 或 Markdown 源文件", "warn");
    return;
  }
  const autoInit = $("#autoInitAfterSplit")?.checked;
  const runBtn = $("#runSplitBtn");
  setSplitProgress(`准备切分 ${ranges.length} 组页码…\n源文件: ${source}`);
  manageLog(`开始切分 ${ranges.length} 组 · ${source}`, "info");
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = "切分中…";
  }
  let splitResult = null;
  try {
    const r = await fetch(`/routers/${encodeURIComponent(manageSelectedRouterId)}/split/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ranges, source_file: source, auto_initialize: !!autoInit }),
    });
    if (!r.ok) {
      const txt = await r.text();
      let detail = txt;
      try {
        detail = JSON.parse(txt)?.detail || txt;
      } catch (e) {
        /* ignore */
      }
      throw new Error(detail || r.statusText);
    }
    const reader = r.body?.getReader();
    if (!reader) throw new Error("浏览器不支持流式响应");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const block of parts) {
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        if (parsed.event === "log") {
          const msg = parsed.data?.message || "";
          if (msg) {
            appendSplitProgress(msg);
            manageLog(msg, parsed.data?.level || "info");
          }
        } else if (parsed.event === "done") {
          splitResult = parsed.data;
        } else if (parsed.event === "error") {
          throw new Error(parsed.data?.message || "切分失败");
        }
      }
    }
    await reloadManageData();
    refreshTestPageSideData();
    const results = splitResult?.results || [];
    const ok = results.filter((x) => x.status === "ok").length;
    const failed = results.filter((x) => x.status === "error");
    if (failed.length) {
      for (const item of failed) {
        manageLog(
          `切分失败 p${item.page_start}-${item.page_end}: ${item.error || "未知错误"}`,
          "err"
        );
      }
      appendSplitProgress(`\n完成：成功 ${ok}，失败 ${failed.length}`);
      manageLog(`切分完成：成功 ${ok}，失败 ${failed.length}`, failed.length ? "warn" : "ok");
    } else {
      appendSplitProgress(`\n全部完成：新建 ${ok} 个子 Agent`);
      manageLog(`切分完成，新建 ${ok} 个子 Agent`, "ok");
    }
  } catch (e) {
    setSplitProgress(`切分失败：${e?.message || e}`);
    manageLog(`切分失败：${e?.message || e}`, "err");
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = "开始切分";
    }
  }
}

async function openSubAgentMd(agentId) {
  manageOpenFiles.clear();
  manageActiveFile = "";
  const agentDir = getManageAgentDir(agentId);
  const data = await apiJson(`/files/tree?root=${encodeURIComponent(agentDir)}`);
  const mdPaths = [];
  function walk(nodes) {
    for (const n of nodes || []) {
      if (n.type === "file" && n.path.toLowerCase().endsWith(".md")) mdPaths.push(n.path);
      if (n.children) walk(n.children);
    }
  }
  walk(data.tree || []);
  mdPaths.sort();
  if (!mdPaths.length) {
    renderEditorTabs();
    renderManageEditorView();
    return;
  }
  for (const p of mdPaths) await openManageEditorFile(p);
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
      preview.innerHTML = `<div class="empty">该子 Agent 暂无 Markdown 文件</div>`;
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

function bindManage() {
  $$("#viewManage .dropdownToggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleManageDropdown(btn);
    });
  });
  document.addEventListener("click", (e) => {
    if (!$("#viewManage")?.classList.contains("active")) return;
    if (!e.target.closest(".headDropdown")) closeAllManageDropdowns();
  });

  $$("[data-router-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeAllManageDropdowns();
      const action = btn.dataset.routerAction;
      const run = () => {
        if (action === "add") return createRouter();
        if (action === "rename") return renameRouter();
        if (action === "delete") return deleteRouter();
        if (action === "refresh") return reloadManageData();
      };
      Promise.resolve(run()).catch((e) => manageLog(e?.message || e, "err"));
    });
  });

  $$("[data-sub-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeAllManageDropdowns();
      const action = btn.dataset.subAction;
      const run = () => {
        if (action === "add") return createSubAgent();
        if (action === "rename") return renameSubAgent();
        if (action === "delete") return deleteSubAgent();
        if (action === "refresh") return refreshSubAgentsOnly();
        if (action === "toggleSelect") {
          toggleSubSelectMode();
          return;
        }
        if (action === "selectAll") {
          selectAllSubAgents();
          return;
        }
        if (action === "selectNone") {
          deselectAllSubAgents();
          return;
        }
        if (action === "initCurrent") return initSubAgent();
        if (action === "initSelected") return initSelectedSubAgents();
        if (action === "initAll") return initAllSubAgents();
      };
      Promise.resolve(run()).catch((e) => manageLog(e?.message || e, "err"));
    });
  });

  updateSubSelectToggleLabel();

  $("#viewManage")?.addEventListener("click", (e) => {
    if (!$("#viewManage")?.classList.contains("active")) return;
    if (e.target.closest("#addSplitRangeBtn")) {
      e.preventDefault();
      addSplitRangeRow();
      return;
    }
    const rm = e.target.closest(".removeRangeBtn");
    if (rm) {
      e.preventDefault();
      removeSplitRangeRow(rm.closest(".splitRangeRow"));
    }
  });

  $("#runSplitBtn")?.addEventListener("click", () => runSplit().catch((e) => manageLog(e?.message || e, "err")));
  $("#savePromptBtn")?.addEventListener("click", () => savePromptEditor().catch((e) => manageLog(e?.message || e, "err")));
  $("#editorSaveBtn")?.addEventListener("click", () => saveManageActiveFile().catch((e) => manageLog(e?.message || e, "err")));
  $("#editorPreviewBtn")?.addEventListener("click", () => {
    manageEditorMode = manageEditorMode === "preview" ? "source" : "preview";
    $("#editorPreviewBtn").textContent = manageEditorMode === "preview" ? "源码" : "预览";
    renderManageEditorView();
  });
  $("#routerUploadInput")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) uploadRouterFile(f).catch((err) => manageLog(err?.message || err, "err"));
    e.target.value = "";
  });
  $("#editorTextarea")?.addEventListener("input", () => {
    const st = manageOpenFiles.get(manageActiveFile);
    if (st) st.dirty = true;
    renderEditorTabs();
  });
  document.addEventListener("keydown", (e) => {
    if (!$("#viewManage")?.classList.contains("active")) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (manageFocus === "subagent") saveManageActiveFile().catch(() => {});
      else savePromptEditor().catch(() => {});
    }
  });
}

bindManage();
