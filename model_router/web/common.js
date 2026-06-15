const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let agentsCache = {};
let routersCache = {};
let lastHealthOk = null;
const VIDEO_EXTS = /\.(mp4|webm|mov)(\?|$)/i;

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isSafeHttpUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
}

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { event, data: JSON.parse(data) };
}

function agentSortKey(id) {
  const n = Number(id);
  if (Number.isFinite(n)) return [0, n, id];
  return [1, 0, id];
}

async function apiJson(url, options = {}) {
  const r = await fetch(url, options);
  const txt = await r.text();
  let data = null;
  try {
    data = JSON.parse(txt);
  } catch (e) {
    if (!r.ok) throw new Error(txt || r.statusText);
    return txt;
  }
  if (!r.ok) throw new Error(data?.detail || txt || r.statusText);
  return data;
}

async function loadRoutersCache() {
  const data = await apiJson("/routers");
  routersCache = data.routers || {};
  return Object.keys(routersCache).length;
}

function routerDisplayName(routerId, router) {
  const cfg = router || routersCache[routerId] || {};
  return (cfg.name || "").trim() || `总Agent_${routerId}`;
}

function subAgentDisplayName(agentId, agent) {
  const cfg = agent || agentsCache[agentId] || {};
  return (cfg.name || "").trim() || `agent_${agentId}`;
}

function agentsForRouter(routerId) {
  const rid = String(routerId || "").trim();
  if (!rid) return {};
  const cfg = routersCache[rid] || {};
  const ids = new Set(cfg.agent_ids || []);
  const out = {};
  for (const [aid, a] of Object.entries(agentsCache || {})) {
    if (ids.has(aid) || String(a?.router_id || "") === rid) out[aid] = a;
  }
  return out;
}

async function loadAgentsCache() {
  const data = await apiJson("/agents");
  agentsCache = data.agents || {};
  return Object.keys(agentsCache).length;
}

async function loadAllCaches() {
  await loadAgentsCache();
  await loadRoutersCache();
}

function populateRouterSelect(selectEl, selectedId = "") {
  if (!selectEl) return;
  const entries = Object.entries(routersCache || {}).sort((a, b) => {
    const na = Number(a[0]);
    const nb = Number(b[0]);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a[0]).localeCompare(String(b[0]));
  });
  selectEl.innerHTML =
    entries.length === 0
      ? `<option value="">（无总 Agent）</option>`
      : entries
          .map(([id, cfg]) => {
            const label = routerDisplayName(id, cfg);
            const sel = id === selectedId ? " selected" : "";
            return `<option value="${escapeHtml(id)}"${sel}>${escapeHtml(label)}</option>`;
          })
          .join("");
  if (selectedId && selectEl.querySelector(`option[value="${selectedId.replace(/"/g, '\\"')}"]`)) {
    selectEl.value = selectedId;
  } else if (entries.length) {
    selectEl.value = entries[0][0];
  }
}

function getSelectedRouterIdFrom(selectEl) {
  return (selectEl?.value || "").trim();
}

function switchAppView(name) {
  $$("[data-app-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.appView === name);
  });
  $("#viewTest").classList.toggle("active", name === "test");
  $("#viewTest").classList.toggle("hidden", name !== "test");
  $("#viewManage").classList.toggle("active", name === "manage");
  $("#viewManage").classList.toggle("hidden", name !== "manage");
  $("#viewBatch").classList.toggle("active", name === "batch");
  $("#viewBatch").classList.toggle("hidden", name !== "batch");
  if (name === "test") {
    testViewEnter();
  }
  if (name === "manage" && typeof manageViewEnter === "function") {
    manageViewEnter();
  }
  if (name === "batch" && typeof batchViewEnter === "function") {
    batchViewEnter();
  }
}

function testViewEnter() {
  loadAllCaches()
    .then(() => populateRouterSelect($("#routerSelect")))
    .then(() => refreshTestPageSideData())
    .catch(() => refreshTestPageSideData());
}

function refreshTestAgentFilesList() {
  if (typeof loadAgentFilesList === "function") {
    loadAgentFilesList("test").catch(() => {});
  }
}

function refreshRouteQuestionsPool() {
  if (typeof loadRouteQuestionsPool === "function") {
    loadRouteQuestionsPool().catch(() => {});
  }
}

function refreshTestPageSideData() {
  refreshTestAgentFilesList();
  refreshRouteQuestionsPool();
}

function refreshBatchFileList() {
  if (typeof loadAgentFilesList === "function") {
    loadAgentFilesList("batch").catch(() => {});
  }
}

async function checkHealth() {
  const dot = $("#healthDot");
  const txt = $("#healthText");
  try {
    const r = await fetch("/health");
    if (!r.ok) throw new Error("bad");
    dot.classList.add("ok");
    dot.classList.remove("bad");
    txt.textContent = "服务正常";
    if (lastHealthOk === false && typeof appendLog === "function") appendLog("服务恢复", "ok");
    lastHealthOk = true;
  } catch (e) {
    dot.classList.add("bad");
    dot.classList.remove("ok");
    txt.textContent = "服务不可用";
    if (lastHealthOk !== false && typeof appendLog === "function") appendLog("服务不可用", "err");
    lastHealthOk = false;
  }
}

function bindCommon() {
  $$("[data-app-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchAppView(btn.dataset.appView));
  });
  checkHealth();
  setInterval(checkHealth, 7000);
}

bindCommon();
