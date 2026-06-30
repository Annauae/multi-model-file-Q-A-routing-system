const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let kbCache = {};
let modalOkHandler = null;
let currentModule = "debug";
let currentSub = "single";
let currentManageSub = "items";

const MODULE_LABELS = {
  debug: "调试",
  manage: "管理",
  logs: "日志",
  settings: "设置",
};
const SUB_LABELS = { single: "问答", recall: "召回度测试" };
const MANAGE_SUB_LABELS = { items: "问题管理", files: "文件管理" };

async function withButtonRunning(btn, label, fn) {
  if (!btn || btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.classList.add("btnRunning");
  btn.textContent = label || "运行中…";
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove("btnRunning");
    btn.textContent = orig;
  }
}

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

function sumTokenUsage(a, b) {
  const x = a || {};
  const y = b || {};
  return {
    prompt_tokens: (x.prompt_tokens || 0) + (y.prompt_tokens || 0),
    completion_tokens: (x.completion_tokens || 0) + (y.completion_tokens || 0),
    total_tokens: (x.total_tokens || 0) + (y.total_tokens || 0),
  };
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

const DEBUG_ASK_TIMEOUT_MS = 180000;
const DEBUG_ASK_TIMEOUT_S = DEBUG_ASK_TIMEOUT_MS / 1000;

class AskTimeoutError extends Error {
  constructor(message = "超时") {
    super(message);
    this.name = "AskTimeoutError";
  }
}

function isAskTimeoutError(err) {
  return err instanceof AskTimeoutError || err?.name === "AskTimeoutError";
}

function resetDebugAskIdle() {
  const box = $("#debugAnswersBox");
  if (box) box.innerHTML = `<div class="empty">在左侧栏输入问题并提问。</div>`;
  const cand = $("#debugCandidatesBox");
  if (cand) cand.innerHTML = `<div class="empty">未匹配到候选</div>`;
  renderTimingsPanel($("#askTimingPanel"), null);
  renderTokenPanel($("#askTokenPanel"), null);
}

function renderAskTimeoutMetrics() {
  const html = `<div class="metricTimeout">超时</div>`;
  const tp = $("#askTimingPanel");
  const tok = $("#askTokenPanel");
  if (tp) tp.innerHTML = html;
  if (tok) tok.innerHTML = html;
  if (typeof switchRightTab === "function") switchRightTab("timing");
}

async function consumeSseStream(resp, onEvent, { signal } = {}) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new AskTimeoutError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new AskTimeoutError();
      if (value) buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseSseBlock(block);
        if (evt) {
          if (evt.event === "error" && evt.data?.timed_out) throw new AskTimeoutError(evt.data.detail || "超时");
          onEvent(evt);
        }
      }
      if (done) {
        if (buffer.trim()) {
          const evt = parseSseBlock(buffer);
          if (evt) {
            if (evt.event === "error" && evt.data?.timed_out) throw new AskTimeoutError(evt.data.detail || "超时");
            onEvent(evt);
          }
        }
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

async function streamAskConfidence(body, onEvent) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEBUG_ASK_TIMEOUT_MS);
  try {
    let resp;
    try {
      resp = await fetch("/ask/confidence/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted || e?.name === "AbortError") throw new AskTimeoutError();
      throw new Error("无法连接服务器，请确认服务已启动");
    }
    if (!resp.ok) throw new Error(await resp.text());
    await consumeSseStream(resp, onEvent, { signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted || e?.name === "AbortError") throw new AskTimeoutError();
    if (isAskTimeoutError(e)) throw e;
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiJson(url, options = {}) {
  let r;
  try {
    r = await fetch(url, options);
  } catch {
    throw new Error("无法连接服务器，请确认 knowledge server 已启动（./start-knowledge-server.ps1，端口 8001）");
  }
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
  for (const item of data.items || []) kbCache[item.kb_id] = item;
  return Object.keys(kbCache).length;
}

function kbDisplayName(kbId) {
  const cfg = kbCache[kbId] || {};
  return (cfg.name || "").trim() || `kb_${kbId}`;
}

let matchProfilesCache = { default_id: "", profiles: [] };

async function refreshMatchProfileSelects() {
  const data = await apiJson("/settings/match-profiles");
  matchProfilesCache = data;
  for (const selId of ["#debugMatchProfileSelect", "#recallMatchProfileSelect"]) {
    const el = $(selId);
    if (!el) continue;
    const cur = el.value;
    const profiles = data.profiles || [];
    el.innerHTML = profiles.length
      ? profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join("")
      : `<option value="">无配置</option>`;
    const def = data.default_id || profiles[0]?.id;
    if (cur && profiles.some((p) => p.id === cur)) el.value = cur;
    else if (def) el.value = def;
  }
}

function selectedMatchProfileId(selectEl) {
  const el = selectEl || $("#debugMatchProfileSelect");
  return (el?.value || matchProfilesCache.default_id || "").trim();
}

function matchProfileLabel(profileId) {
  const p = (matchProfilesCache.profiles || []).find((x) => x.id === profileId);
  return p ? `${p.name || p.id} (${p.model || ""})` : profileId || "—";
}

async function populateKbSelect(selectEl, opts = {}) {
  const el = selectEl || $("#debugKbSelect");
  if (!el) return;
  await loadKbCache();
  const ids = Object.keys(kbCache).sort((a, b) => Number(a) - Number(b));
  const cur = el.value;
  const emptyOpt = opts.emptyLabel
    ? `<option value="">${escapeHtml(opts.emptyLabel)}</option>`
    : "";
  el.innerHTML = ids.length
    ? emptyOpt + ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(kbDisplayName(id))}</option>`).join("")
    : `<option value="">无知识库</option>`;
  if (cur && ids.includes(cur)) el.value = cur;
}

async function pollHealth() {
  try {
    await apiJson("/health");
    $("#healthDot")?.classList.add("ok");
    $("#healthDot")?.classList.remove("err");
    if ($("#healthText")) $("#healthText").textContent = "已连接";
  } catch {
    $("#healthDot")?.classList.add("err");
    $("#healthDot")?.classList.remove("ok");
    if ($("#healthText")) $("#healthText").textContent = "连接失败";
  }
}

function updateBreadcrumb() {
  const bc = $("#breadcrumb");
  if (!bc) return;
  let text = `首页 / <strong>${MODULE_LABELS[currentModule] || currentModule}</strong>`;
  if (currentModule === "debug" && currentSub) {
    text += ` / ${SUB_LABELS[currentSub] || currentSub}`;
  }
  if (currentModule === "manage" && currentManageSub) {
    text += ` / ${MANAGE_SUB_LABELS[currentManageSub] || currentManageSub}`;
  }
  bc.innerHTML = text;
}

function switchRightTab(tab) {
  $$("#rightTabs [data-right-tab]").forEach((b) => b.classList.toggle("active", b.dataset.rightTab === tab));
  $$("#rightTabAsk,#rightTabCandidates,#rightTabTiming,#rightTabTokens").forEach((p) =>
    p.classList.remove("active")
  );
  const pane = $(`#rightTab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`);
  pane?.classList.add("active");
}

function renderTimingsPanel(el, timings, emptyText = "提问后显示", mode = "ask") {
  if (!el) return;
  if (!timings) {
    el.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const chips =
    mode === "import"
      ? [
          ["总耗时", timings.total_ms],
          ["PDF/VLM 提取", timings.prepare_ms],
          ["LLM 生成", timings.match_ms],
        ]
      : [
          ["总耗时", timings.total_ms],
          ["准备(索引+prompt)", timings.prepare_ms],
          ["匹配(LLM)", timings.match_ms],
          ["首 token", timings.match_first_token_ms],
          ["查表(取 answer)", timings.lookup_ms],
        ];
  el.innerHTML = chips
    .map(([label, val]) => {
      const n = Number(val);
      const display = Number.isFinite(n) && n >= 0 ? fmtMs(n) : "—";
      return `<div class="timingChip"><span>${escapeHtml(label)}</span><strong>${display}</strong></div>`;
    })
    .join("");
}

function renderTokenPanel(el, timings, emptyText = "提问后显示") {
  if (!el) return;
  if (!timings?.tokens) {
    el.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const t = timings.tokens;
  const chips = [
    ["总 Token", t.total_tokens],
    ["输入 Token", t.prompt_tokens],
    ["输出 Token", t.completion_tokens],
  ];
  let html = chips
    .map(([label, val]) => `<div class="tokenChip"><span>${escapeHtml(label)}</span><strong>${val ?? 0}</strong></div>`)
    .join("");
  if (timings.token_breakdown?.length) {
    html += `<div class="muted tokenBreakdownHead">细分（各阶段）</div>`;
    html += timings.token_breakdown
      .map((row) => {
        const u = row.usage || {};
        return `<div class="tokenBreakdownRow">
          <div class="tokenBreakdownPhase">${escapeHtml(row.phase)}</div>
          <div class="tokenBreakdownStats">
            <div class="tokenChip"><span>输入 Token</span><strong>${u.prompt_tokens ?? 0}</strong></div>
            <div class="tokenChip"><span>输出 Token</span><strong>${u.completion_tokens ?? 0}</strong></div>
          </div>
        </div>`;
      })
      .join("");
  }
  el.innerHTML = html;
}

function fmtConfidence(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function updateModuleMetricsVisibility() {
  const isDebugAsk = currentModule === "debug" && currentSub === "single";
  const isRecall = currentModule === "debug" && currentSub === "recall";
  $$(".moduleMetrics.ask").forEach((el) => el.classList.toggle("hidden", !isDebugAsk));
  $$(".moduleMetrics.recall").forEach((el) => el.classList.toggle("hidden", !isRecall));
}

function updateRightSidePanels() {
  const isDebugAsk = currentModule === "debug" && currentSub === "single";
  const isRecall = currentModule === "debug" && currentSub === "recall";
  $$(".moduleSide.debug.single").forEach((el) => el.classList.toggle("hidden", !isDebugAsk));
  $$(".moduleSide.recall").forEach((el) => el.classList.toggle("hidden", !isRecall));
  const askTab = $(`#rightTabs [data-right-tab="ask"]`);
  if (askTab) askTab.textContent = isRecall ? "操作" : "提问";
  const candTab = $(`#rightTabs [data-right-tab="candidates"]`);
  if (candTab) candTab.classList.toggle("hidden", isRecall);
}

function switchManageSub(sub, opts = {}) {
  const { skipEnter = false } = opts;
  currentManageSub = sub || "items";
  if (currentManageSub !== "items") {
    $("#itemEditOverlay")?.classList.add("hidden");
  }
  $$("#manageSubNav .manageNavItem").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.manageSub === currentManageSub);
  });
  $$(".manageSubPane").forEach((pane) => pane.classList.remove("active"));
  const paneMap = { items: "manageSubPaneItems", files: "manageSubPaneFiles" };
  $(`#${paneMap[currentManageSub] || paneMap.items}`)?.classList.add("active");

  const appBody = $("#appBody");
  const leftPanel = $("#rightPanel");
  const isDebug = currentModule === "debug";
  const showLeft = isDebug && (currentSub === "single" || currentSub === "recall");
  appBody?.classList.toggle("withLeft", showLeft);
  appBody?.classList.remove("withLeftNarrow");
  leftPanel?.classList.toggle("visible", showLeft);

  updateRightSidePanels();
  updateModuleMetricsVisibility();
  updateBreadcrumb();

  if (currentManageSub === "files" && typeof filesViewEnter === "function" && !skipEnter) {
    filesViewEnter();
  }
}

function switchModule(module, sub) {
  currentModule = module;
  if (module === "debug" && sub !== undefined) currentSub = sub;
  if (module === "manage" && sub !== undefined) currentManageSub = sub;

  $$(".viewPane").forEach((p) => p.classList.remove("active"));
  $$(".navItem").forEach((n) => n.classList.remove("active"));
  $$(".navGroupHead").forEach((h) => h.classList.remove("active"));

  const appBody = $("#appBody");
  const leftPanel = $("#rightPanel");
  const isDebugAsk = module === "debug" && currentSub === "single";
  const isRecall = module === "debug" && currentSub === "recall";
  const showLeft = isDebugAsk || isRecall;
  appBody?.classList.toggle("withLeft", showLeft);
  appBody?.classList.remove("withLeftNarrow");
  leftPanel?.classList.toggle("visible", showLeft);

  if (isRecall) switchRightTab("ask");
  else if (isDebugAsk) switchRightTab("ask");

  updateRightSidePanels();
  updateModuleMetricsVisibility();

  if (module === "debug") {
    if (currentSub === "recall") {
      $("#viewDebugRecall")?.classList.add("active");
      $(`.navItem[data-sub="recall"]`)?.classList.add("active");
      if (typeof recallViewEnter === "function") recallViewEnter();
    } else {
      $("#viewDebugSingle")?.classList.add("active");
      $(`.navItem[data-sub="single"]`)?.classList.add("active");
      if (typeof debugViewEnter === "function") debugViewEnter();
    }
    $(`.navGroupHead[data-nav="debug"]`)?.classList.add("active");
  } else {
    $(`#view${module.charAt(0).toUpperCase()}${module.slice(1)}`)?.classList.add("active");
    $(`.navGroupHead[data-nav="${module}"]`)?.classList.add("active");
    if (module === "manage") {
      switchManageSub(currentManageSub, { skipEnter: true });
      if (currentManageSub === "items" && typeof manageViewEnter === "function") manageViewEnter();
      else if (currentManageSub === "files" && typeof filesViewEnter === "function") filesViewEnter();
    }
    if (module === "logs" && typeof logsViewEnter === "function") logsViewEnter();
    if (module === "settings" && typeof settingsViewEnter === "function") settingsViewEnter();
  }

  updateBreadcrumb();
}

function promptCreateKb(onCreated) {
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
      await loadKbCache();
      if (onCreated) await onCreated(data.kb_id);
      showToast("知识库已创建");
    }
  );
}

function showModal(title, bodyHtml, onOk, wide) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  const modal = document.querySelector("#modalOverlay .modal");
  modal?.classList.toggle("modalWide", !!wide);
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
  setTimeout(() => el.remove(), durationMs);
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

function bindSidebar() {
  $$(".navGroupHead").forEach((head) => {
    head.addEventListener("click", () => {
      const nav = head.dataset.nav;
      const group = head.closest(".navGroup");
      if (nav === "debug") {
        group?.classList.toggle("collapsed");
        switchModule("debug", currentSub || "single");
        return;
      }
      switchModule(nav);
    });
  });
  $$(".navItem[data-module]").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      switchModule(item.dataset.module, item.dataset.sub);
    });
  });
}

document.addEventListener("click", () => closeAllDropdowns());

document.addEventListener("DOMContentLoaded", () => {
  bindSidebar();
  $$(".dropdown").forEach(bindDropdown);
  $$("#rightTabs [data-right-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchRightTab(btn.dataset.rightTab));
  });
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
  switchModule("debug", "single");
});
