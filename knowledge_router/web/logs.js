let logsPaused = false;
let logsPollTimer = null;
let logsCurrentModule = "";

function renderLogEntry(entry) {
  const kind = entry.kind || entry.action || "log";
  const ts = (entry.ts || "").replace("T", " ").replace("Z", "");
  const mod = entry.module ? `[${entry.module}]` : "";
  const kb = entry.kb_id ? ` kb=${entry.kb_id}` : "";
  return `<div class="logBlock ${escapeHtml(kind)}"><span class="logLine">${escapeHtml(ts)} ${escapeHtml(mod)}${escapeHtml(kb)} ${escapeHtml(entry.detail || "")}</span></div>`;
}

async function fetchLogs(module) {
  const mod = module !== undefined ? module : logsCurrentModule;
  logsCurrentModule = mod;
  const kb_id = ($("#logsKbSelect")?.value || "").trim();
  const qs = new URLSearchParams({ limit: "500" });
  if (mod) qs.set("module", mod);
  if (kb_id) qs.set("kb_id", kb_id);
  const data = await apiJson(`/logs?${qs}`);
  const box = $("#logsBox");
  if (!box) return;
  const items = data.items || [];
  box.innerHTML = items.length ? items.map(renderLogEntry).join("") : `<div class="empty">暂无日志</div>`;
  if (!logsPaused) box.scrollTop = box.scrollHeight;
}

let logsNavBound = false;

function bindLogsNav() {
  if (logsNavBound) return;
  logsNavBound = true;
  $("#logsSubNav")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".logsNavItem");
    if (!btn) return;
    $$("#logsSubNav .logsNavItem").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    fetchLogs(btn.dataset.logModule || "").catch(() => {});
  });
}

async function logsViewEnter() {
  const el = $("#logsKbSelect");
  if (el) {
    const cur = el.value;
    await loadKbCache();
    const ids = Object.keys(kbCache).sort((a, b) => Number(a) - Number(b));
    el.innerHTML =
      `<option value="">全部知识库</option>` +
      ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(kbDisplayName(id))}</option>`).join("");
    if (cur && ids.includes(cur)) el.value = cur;
  }
  fetchLogs(logsCurrentModule).catch(() => {});
  if (logsPollTimer) clearInterval(logsPollTimer);
  logsPollTimer = setInterval(() => {
    if (!logsPaused && currentModule === "logs") fetchLogs(logsCurrentModule).catch(() => {});
  }, 3000);
}

document.addEventListener("DOMContentLoaded", () => {
  bindLogsNav();
  $("#logsRefreshBtn")?.addEventListener("click", () => fetchLogs().catch((e) => showToast(e.message, "error")));
  $("#logsPauseBtn")?.addEventListener("click", () => {
    logsPaused = !logsPaused;
    $("#logsPauseBtn").textContent = logsPaused ? "继续" : "暂停";
  });
  $("#logsClearBtn")?.addEventListener("click", async () => {
    if (!confirm("确定清空全部操作日志？")) return;
    await apiJson("/logs", { method: "DELETE" });
    fetchLogs();
    showToast("日志已清空");
  });
  $("#logsKbSelect")?.addEventListener("change", () => fetchLogs().catch(() => {}));
});
