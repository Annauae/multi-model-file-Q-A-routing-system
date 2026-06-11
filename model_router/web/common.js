const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let agentsCache = {};
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

async function loadAgentsCache() {
  const data = await apiJson("/agents");
  agentsCache = data.agents || {};
  return Object.keys(agentsCache).length;
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
  refreshTestPageSideData();
  if (typeof loadAgentFilesList === "function") {
    loadAgentFilesList("test").catch(() => {});
  }
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
