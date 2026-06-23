/**
 * common.js — 前端公共层
 *
 * 职责：DOM 工具、apiJson 封装、知识库下拉、视图切换、健康检查、Tab 切换
 * 依赖：无（最先加载）
 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let kbCache = {};
let lastHealthOk = null;
let currentKbId = "";

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

async function loadKbCache() {
  const data = await apiJson("/knowledge-bases");
  kbCache = data.knowledge_bases || {};
  return Object.keys(kbCache).length;
}

function kbDisplayName(kbId, cfg) {
  const c = cfg || kbCache[kbId] || {};
  return (c.name || "").trim() || `知识库_${kbId}`;
}

function populateKbSelect(selectEl, selectedId = "") {
  if (!selectEl) return;
  const entries = Object.entries(kbCache || {}).sort((a, b) => {
    const na = Number(a[0]);
    const nb = Number(b[0]);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a[0]).localeCompare(String(b[0]));
  });
  selectEl.innerHTML =
    entries.length === 0
      ? `<option value="">（无知识库）</option>`
      : entries
          .map(([id, cfg]) => {
            const label = kbDisplayName(id, cfg);
            const sel = id === selectedId ? " selected" : "";
            return `<option value="${escapeHtml(id)}"${sel}>${escapeHtml(label)}</option>`;
          })
          .join("");
  if (selectedId && selectEl.querySelector(`option[value="${CSS.escape(selectedId)}"]`)) {
    selectEl.value = selectedId;
  } else if (entries.length) {
    selectEl.value = entries[0][0];
  }
  currentKbId = getSelectedKbIdFrom(selectEl);
}

function getSelectedKbIdFrom(selectEl) {
  return (selectEl?.value || currentKbId || "").trim();
}

function switchAppView(name) {
  $$("[data-app-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.appView === name);
  });
  $("#viewTest").classList.toggle("active", name === "test");
  $("#viewTest").classList.toggle("hidden", name !== "test");
  $("#viewManage").classList.toggle("active", name === "manage");
  $("#viewManage").classList.toggle("hidden", name !== "manage");
  if (name === "test" && typeof testViewEnter === "function") testViewEnter();
  if (name === "manage" && typeof manageViewEnter === "function") manageViewEnter();
}

function testViewEnter() {
  loadKbCache()
    .then(() => populateKbSelect($("#kbSelect")))
    .then(() => {
      if (typeof refreshJsonPreview === "function") refreshJsonPreview();
    })
    .catch(() => {});
}

async function pollHealth() {
  const dot = $("#healthDot");
  const txt = $("#healthText");
  try {
    await apiJson("/health");
    if (lastHealthOk !== true) {
      dot?.classList.remove("bad");
      dot?.classList.add("ok");
      if (txt) txt.textContent = "已连接";
    }
    lastHealthOk = true;
  } catch (e) {
    if (lastHealthOk !== false) {
      dot?.classList.remove("ok");
      dot?.classList.add("bad");
      if (txt) txt.textContent = "未连接";
    }
    lastHealthOk = false;
  }
}

$$("[data-app-view]").forEach((btn) => {
  btn.addEventListener("click", () => switchAppView(btn.dataset.appView));
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".headDropdown")) {
    $$(".dropdownMenu").forEach((m) => m.classList.add("hidden"));
  }
});

$$(".dropdownToggle").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = btn.closest(".headDropdown")?.querySelector(".dropdownMenu");
    if (!menu) return;
    const open = menu.classList.contains("hidden");
    $$(".dropdownMenu").forEach((m) => m.classList.add("hidden"));
    if (open) menu.classList.remove("hidden");
  });
});

$$("[data-right-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.rightTab;
    $$("[data-right-tab]").forEach((b) => b.classList.toggle("active", b.dataset.rightTab === tab));
    $("#rightTabLog")?.classList.toggle("active", tab === "log");
    $("#rightTabFiles")?.classList.toggle("active", tab === "files");
  });
});

$$("[data-left-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.leftTab;
    $$(".leftTabHead [data-left-tab]").forEach((b) => b.classList.toggle("active", b.dataset.leftTab === tab));
    $("#leftTabAnswer")?.classList.toggle("active", tab === "answer");
    $("#leftTabMatch")?.classList.toggle("active", tab === "match");
  });
});

pollHealth();
setInterval(pollHealth, 7000);
switchAppView("test");
