/**
 * test.js — 单问题测试页
 *
 * 职责：POST /ask/stream SSE 消费、匹配/回答/引用/耗时/日志 UI
 * 事件：log | match_delta | match | done | error
 */
let answerViewMode = "preview";
let streamAnswerRaw = "";
let streamMatchRaw = "";
let logMatchStreamEl = null;
let lastTimings = null;
let lastDoneData = null;
let questionsPool = [];
const LOG_MAX_LINES = 800;

function setAnswerViewMode(mode) {
  answerViewMode = mode === "source" ? "source" : "preview";
  $("#answerPreviewBtn")?.classList.toggle("primary", answerViewMode === "preview");
  $("#answerPreviewBtn")?.classList.toggle("ghost", answerViewMode !== "preview");
  $("#answerSourceBtn")?.classList.toggle("primary", answerViewMode === "source");
  $("#answerSourceBtn")?.classList.toggle("ghost", answerViewMode !== "source");
  refreshAnswerView();
}

function hideAnswerContent() {
  $("#answerViewToolbar")?.classList.add("hidden");
  $("#streamAnswerPreview")?.classList.add("hidden");
  $("#streamAnswerSource")?.classList.add("hidden");
  $("#answersBox")?.classList.remove("hidden");
}

function showAnswerContent(label) {
  $("#answerLabel").textContent = label || "回答";
  $("#answersBox")?.classList.add("hidden");
  $("#answerViewToolbar")?.classList.remove("hidden");
  refreshAnswerView();
}

function refreshAnswerView() {
  const preview = $("#streamAnswerPreview");
  const source = $("#streamAnswerSource");
  const raw = streamAnswerRaw || "";
  const kbId = getSelectedKbIdFrom($("#kbSelect"));
  const usePreview = answerViewMode === "preview";
  preview?.classList.toggle("hidden", !usePreview);
  source?.classList.toggle("hidden", usePreview);
  if (usePreview && preview) {
    preview.innerHTML = renderAnswerMarkdownPreview(raw, kbId);
  } else if (source) {
    source.textContent = raw || "（空）";
  }
}

function formatLogDetail(detail) {
  if (detail == null || detail === "") return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch (e) {
    return String(detail);
  }
}

function appendLog(message, kind = "info") {
  const box = $("#logBox");
  if (!box) return;
  const ts = new Date().toLocaleTimeString();
  const row = document.createElement("div");
  row.className = `logLine ${kind}`;
  row.textContent = `[${ts}] ${message}`;
  box.appendChild(row);
  trimLogBox(box);
  scrollLogToBottom();
}

function appendLogBlock(title, content, kind = "info") {
  const box = $("#logBox");
  if (!box) return;
  const ts = new Date().toLocaleTimeString();
  const text = formatLogDetail(content).trim();
  if (!text) return;
  const wrap = document.createElement("div");
  wrap.className = "logBlock";
  wrap.innerHTML = `<div class="logBlockTitle">[${ts}] ${escapeHtml(title)}</div>`;
  const pre = document.createElement("pre");
  pre.className = `logLine ${kind}`;
  pre.style.margin = "0";
  pre.textContent = text;
  wrap.appendChild(pre);
  box.appendChild(wrap);
  trimLogBox(box);
  scrollLogToBottom();
}

function trimLogBox(box) {
  while (box.children.length > LOG_MAX_LINES) box.removeChild(box.firstChild);
}

function scrollLogToBottom() {
  const box = document.querySelector(".logScroll") || $("#logBox");
  if (box) box.scrollTop = box.scrollHeight;
}

function appendSseLog(data) {
  const level = data.level || "info";
  const message = data.message || "";
  const detail = data.detail;
  if (detail !== undefined && detail !== null && detail !== "") {
    appendLogBlock(message, detail, level);
  } else {
    appendLog(message, level);
  }
}

function clearLogs() {
  const box = $("#logBox");
  if (box) box.innerHTML = "";
  logMatchStreamEl = null;
}

function ensureLogMatchStream() {
  if (logMatchStreamEl) return logMatchStreamEl;
  const box = $("#logBox");
  const wrap = document.createElement("div");
  wrap.className = "logBlock";
  wrap.innerHTML = `<div class="logBlockTitle">匹配流式</div>`;
  const pre = document.createElement("pre");
  pre.className = "logLine match";
  pre.style.margin = "0";
  wrap.appendChild(pre);
  box.appendChild(wrap);
  logMatchStreamEl = pre;
  scrollLogToBottom();
  return logMatchStreamEl;
}

function renderTimingsPanel(timings, data) {
  const box = $("#timingPanel");
  if (!box) return;
  if (!timings) {
    box.innerHTML = `<div class="empty">提问后显示</div>`;
    return;
  }
  const rows = [
    ["匹配首字", timings.match_first_token_ms],
    ["匹配完成", timings.match_ms],
    ["内存查表", timings.lookup_ms],
    ["总耗时", timings.total_ms],
  ].filter(([, ms]) => ms != null && Number(ms) >= 0);

  box.innerHTML = `
    <div class="timingBar verticalTiming">
      ${rows
        .map(
          ([label, ms]) =>
            `<div class="timingChip block"><strong>${escapeHtml(label)}</strong> <span class="timingValue">${fmtMs(ms)}</span></div>`
        )
        .join("")}
    </div>
    ${
      data?.cache_hit
        ? `<div class="cacheMeta">内存缓存 · enabled ${data.enabled_count ?? "—"} · loaded ${escapeHtml(data.kb_loaded_at || "—")}</div>`
        : ""
    }
  `;
}

function updateTimingBar(timings, data) {
  if (timings === null) {
    lastTimings = null;
    lastDoneData = null;
  } else {
    if (timings) lastTimings = timings;
    if (data) lastDoneData = data;
  }
  renderTimingsPanel(lastTimings, lastDoneData);
}

function renderMatchRaw(raw, streaming = false) {
  const label = streaming ? "匹配模型输出（流式）" : "匹配模型输出（JSON）";
  const text = (raw || "").trim();
  if (!text) return "";
  return `
    <div class="routeRaw">
      <div class="routeRawHead">${escapeHtml(label)}</div>
      <pre class="routeRawBody">${escapeHtml(text)}</pre>
    </div>
  `;
}

function renderMatch(data) {
  const box = $("#matchBox");
  if (!data) {
    box.innerHTML = `<div class="empty">等待提问…</div>`;
    return;
  }
  const match = data.match || data;
  const rawHtml = renderMatchRaw(streamMatchRaw || data.match_raw || "");
  if (match.need_clarification) {
    box.innerHTML = `
      ${rawHtml}
      <div class="routeCard clarify">
        <div class="routeTop"><div class="pill warn"><strong>need_clarification</strong></div></div>
        <div class="routeReason">${escapeHtml(match.clarification_question || "需要补充信息")}</div>
      </div>`;
    return;
  }
  if (!match.matched_id) {
    box.innerHTML = `${rawHtml}<div class="empty">未匹配到标准问题。</div>`;
    return;
  }
  const variants = (match.matched_variants || []).map((v) => `<li>${escapeHtml(v)}</li>`).join("");
  box.innerHTML = `
    ${rawHtml}
    <div class="routeCard hit">
      <div class="routeTop"><div class="pill ok"><strong>${escapeHtml(match.matched_id)}</strong></div></div>
      <div class="routeId">标准问题</div>
      <div class="routeReason">${escapeHtml(match.matched_question || "")}</div>
      ${variants ? `<div class="routeId">变体问法</div><ul class="variantList">${variants}</ul>` : ""}
    </div>`;
}

function renderResources(data) {
  const box = $("#resourcesContent");
  if (!box) return;
  if (!data || data.match?.need_clarification) {
    box.innerHTML = `<div class="empty">等待回答…</div>`;
    return;
  }
  const cites = data.citations || [];
  if (!cites.length) {
    box.innerHTML = `<div class="empty">无引用</div>`;
    return;
  }
  box.innerHTML = `<div class="sources"><ul>${cites
    .map((c) => {
      const file = escapeHtml(c.file || "");
      const snippet = escapeHtml(c.snippet || "");
      const lines =
        c.line_start != null
          ? `L${c.line_start}${c.line_end && c.line_end !== c.line_start ? `-L${c.line_end}` : ""}`
          : "";
      return `<li><code>${file}${lines ? ` · ${lines}` : ""}</code>${snippet ? `<div class="cap">${snippet}</div>` : ""}</li>`;
    })
    .join("")}</ul></div>`;
}

async function loadQuestionsPool() {
  const kbId = getSelectedKbIdFrom($("#kbSelect"));
  if (!kbId) {
    questionsPool = [];
    return;
  }
  try {
    const data = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/questions`);
    questionsPool = (data.document?.items || [])
      .filter((x) => x.enabled !== false)
      .flatMap((x) => [x.question, ...(x.variants || [])])
      .filter(Boolean);
  } catch (e) {
    questionsPool = [];
  }
}

async function refreshJsonPreview() {
  const box = $("#jsonPreviewBox");
  const kbId = getSelectedKbIdFrom($("#kbSelect"));
  if (!box || !kbId) {
    if (box) box.textContent = "请选择知识库";
    return;
  }
  try {
    const data = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/questions`);
    box.textContent = JSON.stringify(data.document, null, 2);
  } catch (e) {
    box.textContent = String(e.message || e);
  }
}

async function askQuestion() {
  const q = ($("#question")?.value || "").trim();
  const kbId = getSelectedKbIdFrom($("#kbSelect"));
  if (!q) return alert("请输入问题");
  if (!kbId) return alert("请选择知识库");

  $("#askBtn").disabled = true;
  clearLogs();
  streamAnswerRaw = "";
  streamMatchRaw = "";
  logMatchStreamEl = null;
  hideAnswerContent();
  $("#answersBox").innerHTML = `<div class="empty">匹配中…</div>`;
  renderMatch(null);
  renderResources(null);
  updateTimingBar(null);

  appendLog(`POST /ask/stream · kb=${kbId}`, "info");

  try {
    const resp = await fetch("/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, kb_id: kbId }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText || resp.statusText);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const evt = parseSseBlock(part);
        if (!evt) continue;
        if (evt.event === "log") appendSseLog(evt.data);
        if (evt.event === "match_delta") {
          streamMatchRaw += evt.data.content || "";
          ensureLogMatchStream().textContent = streamMatchRaw;
          scrollLogToBottom();
        }
        if (evt.event === "match") {
          renderMatch({ match: evt.data.match, match_raw: streamMatchRaw });
          if (evt.data.timings) updateTimingBar({ ...lastTimings, ...evt.data.timings }, lastDoneData);
        }
        if (evt.event === "done") {
          const data = evt.data;
          lastDoneData = data;
          if (data.match?.need_clarification) {
            $("#answersBox").innerHTML = `<div class="empty warn">${escapeHtml(
              data.match.clarification_question || "需要澄清"
            )}</div>`;
            hideAnswerContent();
          } else {
            streamAnswerRaw = data.answer || "";
            showAnswerContent(`回答 · ${data.match?.matched_id || ""}`);
            $("#answersBox").classList.add("hidden");
          }
          renderMatch({ ...data, match_raw: streamMatchRaw });
          renderResources(data);
          updateTimingBar(data.timings, data);
          appendLogBlock("完成响应", data, "ok");
        }
        if (evt.event === "error") {
          appendLog(evt.data.message || "错误", "error");
          alert(evt.data.message || "请求失败");
        }
      }
    }
  } catch (e) {
    appendLog(String(e.message || e), "error");
    alert(String(e.message || e));
  } finally {
    $("#askBtn").disabled = false;
  }
}

function pickRandomQuestion() {
  if (!questionsPool.length) {
    alert("当前知识库没有可用问题");
    return;
  }
  const q = questionsPool[Math.floor(Math.random() * questionsPool.length)];
  $("#question").value = q;
}

$("#askBtn")?.addEventListener("click", askQuestion);
$("#clearBtn")?.addEventListener("click", () => {
  $("#question").value = "";
});
$("#clearLogBtn")?.addEventListener("click", clearLogs);
$("#randomQuestionBtn")?.addEventListener("click", pickRandomQuestion);
$("#answerPreviewBtn")?.addEventListener("click", () => setAnswerViewMode("preview"));
$("#answerSourceBtn")?.addEventListener("click", () => setAnswerViewMode("source"));
$("#kbSelect")?.addEventListener("change", () => {
  currentKbId = getSelectedKbIdFrom($("#kbSelect"));
  loadQuestionsPool();
  refreshJsonPreview();
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter" && $("#viewTest")?.classList.contains("active")) {
    e.preventDefault();
    askQuestion();
  }
});

loadQuestionsPool();
