const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let kbCache = {};
let lastHealthOk = null;
let modalOkHandler = null;

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function fmtLogTime(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
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
  } catch {
    if (!r.ok) throw new Error(txt || r.statusText);
    return txt;
  }
  if (!r.ok) throw new Error(data?.detail || txt || r.statusText);
  return data;
}

async function loadKbCache() {
  const data = await apiJson("/knowledge-bases");
  kbCache = {};
  for (const item of data.items || []) {
    kbCache[item.kb_id] = item;
  }
  return Object.keys(kbCache).length;
}

function kbDisplayName(kbId) {
  const cfg = kbCache[kbId] || {};
  return (cfg.name || "").trim() || `kb_${kbId}`;
}

function getSelectedKbId(fromEl) {
  const el = fromEl || $("#kbSelect");
  return (el?.value || "").trim();
}

async function populateKbSelect(selectEl) {
  const el = selectEl || $("#kbSelect");
  if (!el) return;
  await loadKbCache();
  const ids = Object.keys(kbCache).sort((a, b) => Number(a) - Number(b));
  el.innerHTML = ids.length
    ? ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(kbDisplayName(id))}</option>`).join("")
    : `<option value="">无知识库</option>`;
}

async function pollHealth() {
  try {
    await apiJson("/health");
    lastHealthOk = true;
    $("#healthDot")?.classList.add("ok");
    $("#healthDot")?.classList.remove("err");
    if ($("#healthText")) $("#healthText").textContent = "已连接";
  } catch {
    lastHealthOk = false;
    $("#healthDot")?.classList.add("err");
    $("#healthDot")?.classList.remove("ok");
    if ($("#healthText")) $("#healthText").textContent = "连接失败";
  }
}

function switchAppView(name) {
  $$(".viewPane").forEach((p) => p.classList.add("hidden"));
  $$(".viewPane").forEach((p) => p.classList.remove("active"));
  const pane = $(`#view${name.charAt(0).toUpperCase()}${name.slice(1)}`);
  if (pane) {
    pane.classList.remove("hidden");
    pane.classList.add("active");
  }
  $$(".appNavBtn").forEach((b) => b.classList.toggle("active", b.dataset.appView === name));
  if (name === "test" && typeof testViewEnter === "function") testViewEnter();
  if (name === "manage" && typeof manageViewEnter === "function") manageViewEnter();
  if (name === "confidence" && typeof confidenceViewEnter === "function") confidenceViewEnter();
}

function showModal(title, bodyHtml, onOk) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  const modal = document.querySelector("#modalOverlay .modal");
  modal?.classList.toggle("modalWide", /modalItem/.test(bodyHtml));
  modalOkHandler = onOk;
  $("#modalOverlay").classList.remove("hidden");
}

function hideModal() {
  $("#modalOverlay").classList.add("hidden");
  document.querySelector("#modalOverlay .modal")?.classList.remove("modalWide");
  modalOkHandler = null;
}

function showToast(message, type = "success", durationMs = 2600) {
  const container = $("#toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("fadeOut");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, durationMs);
}

function closeAllDropdowns(except) {
  $$(".dropdownMenu").forEach((menu) => {
    if (except && menu.closest(".dropdown") === except) return;
    menu.classList.add("hidden");
  });
}

function bindDropdown(dropdownEl) {
  const toggle = dropdownEl.querySelector(".dropdownToggle");
  const menu = dropdownEl.querySelector(".dropdownMenu");
  if (!toggle || !menu) return;
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.classList.contains("hidden");
    closeAllDropdowns();
    if (open) menu.classList.remove("hidden");
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
}

document.addEventListener("click", () => closeAllDropdowns());

document.addEventListener("DOMContentLoaded", () => {
  $$(".appNavBtn").forEach((btn) => {
    btn.addEventListener("click", () => switchAppView(btn.dataset.appView));
  });
  $$(".dropdown").forEach(bindDropdown);
  $("#modalCancelBtn")?.addEventListener("click", hideModal);
  $("#modalOkBtn")?.addEventListener("click", async () => {
    if (!modalOkHandler) {
      hideModal();
      return;
    }
    try {
      await modalOkHandler();
      hideModal();
    } catch (e) {
      showToast(e.message || String(e), "error", 3200);
    }
  });
  pollHealth();
  setInterval(pollHealth, 7000);
  switchAppView("test");
});
