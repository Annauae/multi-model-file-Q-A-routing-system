let lastKnowledgeSource = "";
let routeQuestionsPool = [];
let answerViewMode = "preview";
let answerStreaming = false;

function renderAnswerHtml(text, sourceFile) {
  return renderDisplayAnswerHtml(text, sourceFile || lastKnowledgeSource || "");
}

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
  scrollAnswersToBottom();
}

function refreshAnswerView() {
  const preview = $("#streamAnswerPreview");
  const source = $("#streamAnswerSource");
  const raw = streamAnswerRaw || "";
  const src = lastKnowledgeSource || "";
  const usePreview = answerViewMode === "preview" && !answerStreaming;

  preview?.classList.toggle("hidden", !usePreview);
  source?.classList.toggle("hidden", usePreview);

  if (usePreview && preview) {
    preview.innerHTML = renderAnswerMarkdownPreview(raw, src);
  } else if (source) {
    source.textContent = raw || "（空）";
  }
}

function ensureAnswerImageLightbox() {
  let overlay = $("#answerImageLightbox");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "answerImageLightbox";
  overlay.className = "answerImageLightbox hidden";
  overlay.innerHTML =
    '<button type="button" class="answerImageLightboxClose" aria-label="关闭">×</button><img alt="" />';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest(".answerImageLightboxClose")) {
      overlay.classList.add("hidden");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.classList.add("hidden");
  });
  return overlay;
}

function openAnswerImageLightbox(src, alt) {
  const overlay = ensureAnswerImageLightbox();
  const img = overlay.querySelector("img");
  if (img) {
    img.src = src;
    img.alt = alt || "";
  }
  overlay.classList.remove("hidden");
}

function bindAnswerImageZoom() {
  const scroll = document.querySelector(".answerMain .answersScroll");
  if (!scroll || scroll.dataset.zoomBound === "1") return;
  scroll.dataset.zoomBound = "1";
  scroll.addEventListener("click", (e) => {
    const img = e.target.closest("#streamAnswerPreview img, .answerFigure img");
    if (!img?.src) return;
    e.preventDefault();
    openAnswerImageLightbox(img.src, img.alt || "");
  });
}

let streamAnswerRaw = "";
let streamRouteRaw = "";
let logRouteStreamEl = null;
let logAnswerStreamEl = null;
let lastTimings = null;
let lastDoneData = null;
const LOG_MAX_LINES = 800;

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
  while (box.children.length > LOG_MAX_LINES) {
    box.removeChild(box.firstChild);
  }
}

function scrollLogToBottom() {
  const box = document.querySelector(".logScroll") || $("#logBox");
  if (!box) return;
  box.scrollTop = box.scrollHeight;
}

function scrollAnswersToBottom() {
  const box = document.querySelector(".answersScroll");
  if (!box) return;
  box.scrollTop = box.scrollHeight;
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
  logRouteStreamEl = null;
  logAnswerStreamEl = null;
}

function resetLogRouteStream() {
  logRouteStreamEl = null;
}

function resetLogAnswerStream() {
  logAnswerStreamEl = null;
}

function ensureLogRouteStream() {
  if (logRouteStreamEl) return logRouteStreamEl;
  const box = $("#logBox");
  const wrap = document.createElement("div");
  wrap.className = "logBlock";
  wrap.innerHTML = `<div class="logBlockTitle">路由流式</div>`;
  const pre = document.createElement("pre");
  pre.className = "logLine route";
  pre.style.margin = "0";
  wrap.appendChild(pre);
  box.appendChild(wrap);
  logRouteStreamEl = pre;
  scrollLogToBottom();
  return logRouteStreamEl;
}

function ensureLogAnswerStream() {
  if (logAnswerStreamEl) return logAnswerStreamEl;
  const box = $("#logBox");
  const wrap = document.createElement("div");
  wrap.className = "logBlock";
  wrap.innerHTML = `<div class="logBlockTitle">回答流式</div>`;
  const pre = document.createElement("pre");
  pre.className = "logLine ok";
  pre.style.margin = "0";
  wrap.appendChild(pre);
  box.appendChild(wrap);
  logAnswerStreamEl = pre;
  scrollLogToBottom();
  return logAnswerStreamEl;
}

function logRouteTargets(targets) {
  (targets || []).forEach((t) => {
    appendLog(`→ ${t.agent_id} [${t.confidence}] ${t.reason || ""}`, "route");
    if (t.rewritten_query) appendLog(`  rewritten: ${t.rewritten_query}`, "route");
    const mqs = t.matched_route_questions || [];
    if (mqs.length) {
      appendLogBlock(
        `${t.agent_id} matched_route_questions`,
        mqs.map((x) => `- ${x}`).join("\n"),
        "route"
      );
    }
  });
}

function logDoneDetails(data) {
  if (!data) return;
  if (data.need_clarification) {
    appendLog(`需澄清: ${data.clarification_question || ""}`, "warn");
    return;
  }
  (data.answers || []).forEach((a) => {
    appendLog(`Agent ${a.agent_id} (${a.agent_name}) · 回答 ${(a.answer || "").length} 字`, "ok");
    if (a.used_files?.length) appendLog(`  文件: ${a.used_files.join(" · ")}`, "info");
    if (a.context_note) appendLog(`  context: ${a.context_note}`, "info");
    if (a.timings) {
      const tm = a.timings;
      appendLog(
        `  耗时: 读文件 ${fmtMs(tm.load_files_ms)} · LLM ${fmtMs(tm.llm_answer_ms)} · 引用 ${fmtMs(tm.citations_ms)} · 总 ${fmtMs(tm.total_ms)}`,
        "info"
      );
    }
    if (a.citations?.length) {
      const citeCtx = {
        routerName: routerDisplayName(getSelectedRouterIdFrom($("#routerSelect")), routersCache[getSelectedRouterIdFrom($("#routerSelect"))]),
        agentName: (a.agent_name || "").trim() || subAgentDisplayName(a.agent_id, null, getSelectedRouterIdFrom($("#routerSelect"))),
        knowledgeSource: a.knowledge_source || "",
      };
      appendLogBlock(
        `${a.agent_id} citations`,
        a.citations
          .map((c) => `${formatCitationWhere(c, citeCtx)}: ${(c.snippet || "").slice(0, 100)}`)
          .join("\n"),
        "info"
      );
    }
  });
  if (data.merged_answer) {
    appendLogBlock("回答正文", data.merged_answer, "ok");
  }
}

function formatCitationWhere(c, ctx) {
  const file = (c.file || "").trim();
  const asset = (c.asset_file || "").trim();
  const hasPage = Number.isFinite(c.page) && c.page > 0;
  const ls = Number.isFinite(c.line_start) && c.line_start > 0 ? c.line_start : null;
  const le = Number.isFinite(c.line_end) && c.line_end > 0 ? c.line_end : null;
  if (ls != null) {
    const range = le != null && le !== ls ? `L${ls}-L${le}` : `L${ls}`;
    const routerName = (ctx?.routerName || "").trim();
    const agentName = (ctx?.agentName || "").trim();
    if (routerName && agentName) return `${routerName} · ${agentName} · ${range}`;
    const fileLabel = (ctx?.knowledgeSource || file || "").trim();
    if (fileLabel) return `${fileLabel} · ${range}`;
  }
  if (hasPage) return `${file} · p.${c.page}`;
  return asset || file;
}

function citationDisplayContext(data) {
  const answer0 = data?.answers?.[0];
  const routerId = getSelectedRouterIdFrom($("#routerSelect"));
  const routerName = routerDisplayName(routerId, routersCache[routerId]);
  const agentName = (answer0?.agent_name || "").trim() || subAgentDisplayName(answer0?.agent_id, null, routerId);
  const knowledgeSource = answer0?.knowledge_source || lastKnowledgeSource || "";
  return { routerName, agentName, knowledgeSource };
}

function renderEvidenceThumb(c) {
  const file = (c.asset_file || c.file || "").trim();
  const isPdf = file.toLowerCase().endsWith(".pdf");
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(file);
  const hasPage = Number.isFinite(c.page) && c.page > 0;
  if (isPdf && hasPage) {
    return `<a class="thumb" href="/preview?file=${encodeURIComponent(
      file
    )}&page=${encodeURIComponent(c.page)}&zoom=2.0" target="_blank" rel="noreferrer">
      <img loading="lazy" alt="preview" src="/preview?file=${encodeURIComponent(
        file
      )}&page=${encodeURIComponent(c.page)}&zoom=1.2" />
    </a>`;
  }
  if (isImage) {
    return `<a class="thumb" href="/preview-image?file=${encodeURIComponent(
      file
    )}" target="_blank" rel="noreferrer">
      <img loading="lazy" alt="preview" src="/preview-image?file=${encodeURIComponent(file)}" />
    </a>`;
  }
  return "";
}

function confClass(c) {
  return (c ?? "").toLowerCase() === "high" ? "high" : "low";
}

function renderTimingsPanel(timings, data) {
  const box = $("#timingPanel");
  if (!box) return;
  if (!timings) {
    box.innerHTML = `<div class="empty">提问后显示</div>`;
    return;
  }
  const rows = [
    ["路由首字", timings.route_first_token_ms],
    ["路由完成", timings.route_ms],
    ["回答首字", timings.first_token_ms],
    ["Agent 回答", timings.agents_ms],
    ["总耗时", timings.total_ms],
  ].filter(([, ms]) => ms != null && Number(ms) > 0);

  let agentHtml = "";
  const a0 = data?.answers?.[0];
  if (a0?.timings) {
    const tm = a0.timings;
    agentHtml = `
      <div class="timingSection">
        <div class="timingSectionTitle">Agent ${escapeHtml(a0.agent_id)} 明细</div>
        ${renderAgentTimings(tm)}
      </div>`;
  }

  box.innerHTML = `
    <div class="timingBar verticalTiming">
      ${rows
        .map(
          ([label, ms]) =>
            `<div class="timingChip block"><strong>${escapeHtml(label)}</strong> ${fmtMs(ms)}</div>`
        )
        .join("")}
    </div>
    ${agentHtml}
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
function renderRouteTimingsSummary(timings) {
  if (!timings) return "";
  const items = [
    ["路由首字", timings.route_first_token_ms],
    ["路由完成", timings.route_ms],
  ].filter(([, ms]) => ms != null && ms !== undefined && Number(ms) > 0);
  if (!items.length) return "";
  return `
    <div class="timingBar">
      ${items
        .map(
          ([label, ms]) =>
            `<span class="timingChip"><strong>${escapeHtml(label)}</strong> ${fmtMs(ms)}</span>`
        )
        .join("")}
    </div>
  `;
}

function renderAnswerTimingsSummary(timings) {
  if (!timings) return "";
  const items = [
    ["回答首字", timings.first_token_ms],
    ["Agent 回答", timings.agents_ms],
    ["总耗时", timings.total_ms],
  ].filter(([, ms]) => ms != null && ms !== undefined && Number(ms) > 0);
  if (!items.length) return "";
  return `
    <div class="timingBar">
      ${items
        .map(
          ([label, ms]) =>
            `<span class="timingChip"><strong>${escapeHtml(label)}</strong> ${fmtMs(ms)}</span>`
        )
        .join("")}
    </div>
  `;
}

function renderTimingsSummary(timings) {
  if (!timings) return "";
  const items = [
    ["路由首字", timings.route_first_token_ms],
    ["路由完成", timings.route_ms],
    ["回答首字", timings.first_token_ms],
    ["Agent 回答", timings.agents_ms],
    ["总耗时", timings.total_ms],
  ].filter(([, ms]) => ms != null && ms !== undefined && Number(ms) > 0);
  if (!items.length) return "";
  return items
    .map(
      ([label, ms]) =>
        `<span class="timingChip"><strong>${escapeHtml(label)}</strong> ${fmtMs(ms)}</span>`
    )
    .join("");
}

function renderAgentTimings(timings) {
  if (!timings) return "";
  const items = [
    ["总", timings.total_ms],
    ["扫描文件", timings.expand_files_ms],
    ["读取文件", timings.load_files_ms],
    ["LLM 回答", timings.llm_answer_ms],
    ["提取引用", timings.citations_ms],
  ];
  return `
    <div class="timingRow">
      ${items
        .map(
          ([label, ms]) =>
            `<span class="timingMini"><strong>${escapeHtml(label)}</strong> ${fmtMs(ms)}</span>`
        )
        .join("")}
    </div>
  `;
}

function renderRouteRaw(raw, streaming = false) {
  const label = streaming ? "路由模型输出（流式）" : "路由模型输出（JSON）";
  const text = (raw || "").trim();
  if (!text) return "";
  return `
    <div class="routeRaw">
      <div class="routeRawHead">${escapeHtml(label)}</div>
      <pre class="routeRawBody">${escapeHtml(text)}</pre>
    </div>
  `;
}

function renderRoute(data) {
  const box = $("#routeBox");
  if (!data) {
    box.innerHTML = `<div class="empty">等待提问…</div>`;
    return;
  }
  const routeRawHtml = renderRouteRaw(data.route_raw || "");
  if (data.need_clarification) {
    box.innerHTML = `
      ${routeRawHtml}
      <div class="routeCard">
        <div class="routeTop">
          <div class="pill low"><strong>need_clarification</strong></div>
        </div>
        <div class="routeReason">${escapeHtml(data.clarification_question || "需要补充信息")}</div>
      </div>
    `;
    return;
  }

  const targets = data.target_agents ?? [];
  if (!targets.length) {
    box.innerHTML = `${routeRawHtml}<div class="empty">未选中任何 agent。</div>`;
    return;
  }
  const cards = targets
    .map(
      (t) =>
        `<div class="routeCard compact"><div class="routeId">target_agents: <strong>${escapeHtml(t.agent_id)}</strong></div></div>`
    )
    .join("");

  box.innerHTML = `${routeRawHtml}<div class="routeList">${cards}</div>`;
}

function formatCitationLineRef(c, ctx) {
  const ls = Number.isFinite(c.line_start) && c.line_start > 0 ? c.line_start : null;
  const le = Number.isFinite(c.line_end) && c.line_end > 0 ? c.line_end : null;
  if (ls == null) return null;

  const file = (c.file || "").trim();
  const src = (ctx?.knowledgeSource || "").trim();
  const isImagePath = /\.(png|jpe?g|webp|gif)$/i.test(file);
  const isMdRef =
    (src && (file.endsWith(".md") || file === src || isImagePath)) || file.endsWith(".md");
  if (!isMdRef) return null;

  const range = le != null && le !== ls ? `L${ls}-L${le}` : `L${ls}`;
  const routerName = (ctx?.routerName || "").trim();
  const agentName = (ctx?.agentName || "").trim();
  if (routerName && agentName) return `${routerName} · ${agentName} · ${range}`;

  let displayFile = "";
  if (src && (file.endsWith(".md") || file === src || isImagePath)) {
    displayFile = src;
  } else if (file.endsWith(".md")) {
    displayFile = file;
  } else {
    return null;
  }
  return `${displayFile} · ${range}`;
}

function renderResourceThumb(c, knowledgeSource) {
  const asset = (c.asset_file || "").trim();
  if (asset && /\.(png|jpe?g|webp|gif)$/i.test(asset)) {
    if (asset.startsWith("files/")) {
      const href = `/preview-image?file=${encodeURIComponent(asset)}`;
      return `<a class="thumb" href="${href}" target="_blank" rel="noreferrer">
        <img loading="lazy" alt="preview" src="${href}" />
      </a>`;
    }
    if (knowledgeSource) {
      const href = assetPreviewUrl(knowledgeSource, asset);
      return `<a class="thumb" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">
        <img loading="lazy" alt="preview" src="${escapeHtml(href)}" />
      </a>`;
    }
  }
  return renderEvidenceThumb(c);
}

function renderResources(data) {
  const box = $("#resourcesContent");
  if (!box) return;
  if (!data || data.need_clarification) {
    box.innerHTML = `<div class="empty">等待回答…</div>`;
    return;
  }

  const answers = data.answers ?? [];
  const answer0 = answers[0];
  const citeCtx = citationDisplayContext(data);
  if (answer0?.knowledge_source) lastKnowledgeSource = answer0.knowledge_source;
  citeCtx.knowledgeSource = answer0?.knowledge_source || lastKnowledgeSource || citeCtx.knowledgeSource;

  const cites = answer0?.citations ?? [];
  const parts = [];

  const textRefs = [];
  const seenRefs = new Set();
  for (const c of cites) {
    const label = formatCitationLineRef(c, citeCtx);
    if (label && !seenRefs.has(label)) {
      seenRefs.add(label);
      textRefs.push(label);
    }
  }
  if (textRefs.length) {
    parts.push(
      `<div class="sources"><div class="t">引用</div><ul>${textRefs
        .map((label) => `<li><code>${escapeHtml(label)}</code></li>`)
        .join("")}</ul></div>`
    );
  }

  const imageCites = [];
  const seenAssets = new Set();
  for (const c of cites) {
    const asset = (c.asset_file || "").trim();
    if (!asset || !/\.(png|jpe?g|webp|gif)$/i.test(asset) || seenAssets.has(asset)) continue;
    seenAssets.add(asset);
    imageCites.push(c);
  }
  if (imageCites.length) {
    parts.push(
      `<div class="sources"><div class="t">相关图片</div><ul>${imageCites
        .slice(0, 8)
        .map((c) => {
          const cap = (c.snippet || "").trim() || formatCitationWhere(c, citeCtx);
          const img = renderResourceThumb(c, citeCtx.knowledgeSource);
          return `<li>${cap ? `<div class="cap">${escapeHtml(cap.slice(0, 80))}</div>` : ""}${img}</li>`;
        })
        .join("")}</ul></div>`
    );
  }

  box.innerHTML = parts.length ? parts.join("") : `<div class="empty">无引用资源</div>`;
}

function renderAnswers(data) {
  const box = $("#answersBox");
  if (!data) {
    hideAnswerContent();
    if (box) box.innerHTML = `<div class="empty">尚无回答。</div>`;
    $("#answerLabel").textContent = "回答";
    renderResources(null);
    updateTimingBar(null);
    return;
  }
  if (data.need_clarification) {
    hideAnswerContent();
    if (box) {
      box.innerHTML = `
      <div class="empty">
        <strong>未路由到 Agent</strong> · ${escapeHtml(data.clarification_question || "请补充问题信息")}
      </div>
    `;
    }
    $("#answerLabel").textContent = "回答";
    renderResources(data);
    updateTimingBar(data.timings, data);
    return;
  }

  const answer0 = data.answers?.[0];
  if (answer0?.knowledge_source) lastKnowledgeSource = answer0.knowledge_source;

  const merged = data.merged_answer ?? (answer0?.answer ?? "");
  if (!merged && !(data.answers || []).length) {
    hideAnswerContent();
    if (box) box.innerHTML = `<div class="empty">没有返回回答。</div>`;
    $("#answerLabel").textContent = "回答";
    renderResources(data);
    updateTimingBar(data.timings, data);
    return;
  }

  streamAnswerRaw = merged || "";
  answerStreaming = false;
  showAnswerContent("回答");
  renderResources(data);
  updateTimingBar(data.timings, data);
}

function resetStreamingRoute() {
  streamRouteRaw = "";
}

function appendStreamingRoute(text) {
  streamRouteRaw += text;
  const pre = $("#routeRawStream");
  if (pre) pre.textContent = streamRouteRaw;
  ensureLogRouteStream().textContent = streamRouteRaw;
  scrollLogToBottom();
}

function renderStreamingShell(routePayload) {
  streamRouteRaw = routePayload.route_raw || streamRouteRaw || "";
  renderRoute({
    need_clarification: !!routePayload.need_clarification,
    clarification_question: routePayload.clarification_question || "",
    target_agents: routePayload.target_agents || [],
    route_raw: streamRouteRaw,
    timings: {
      route_ms: routePayload.route_ms,
      route_first_token_ms: routePayload.route_first_token_ms,
    },
  });
  resetStreamingAnswer();
  renderResources(null);
  if (routePayload.need_clarification) {
    hideAnswerContent();
    if ($("#answersBox")) {
      $("#answersBox").innerHTML = `
      <div class="empty">${escapeHtml(routePayload.clarification_question || "请补充问题信息")}</div>
    `;
    }
    $("#answerLabel").textContent = "回答";
    return;
  }
  updateTimingBar({
    route_ms: routePayload.route_ms,
    route_first_token_ms: routePayload.route_first_token_ms,
  });
  answerStreaming = true;
  streamAnswerRaw = "";
  showAnswerContent("回答（流式 · 生成中…）");
}

function resetStreamingAnswer() {
  streamAnswerRaw = "";
  refreshAnswerView();
}

function appendStreamingAnswer(text) {
  streamAnswerRaw += text;
  refreshAnswerView();
  ensureLogAnswerStream().textContent = streamAnswerRaw;
  scrollLogToBottom();
  scrollAnswersToBottom();
}

function updateStreamTimings(timings) {
  updateTimingBar(timings);
}

function updateRouteStreamTimings(timings) {
  updateTimingBar(timings);
}

async function ask() {
  const q = $("#question").value.trim();
  if (!q) return;
  const btn = $("#askBtn");
  btn.disabled = true;
  btn.textContent = "生成中…";
  renderRoute(null);
  renderAnswers(null);
  resetStreamingRoute();
  resetLogRouteStream();
  resetLogAnswerStream();
  appendLog(`提问: ${q}`);
  try {
    appendLog("开始流式请求 /ask/stream");
    const r = await fetch("/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, router_id: getSelectedRouterIdFrom($("#routerSelect")) }),
    });
    if (!r.ok) {
      const txt = await r.text();
      let detail = txt;
      try {
        detail = JSON.parse(txt)?.detail || txt;
      } catch (e) {
        /* keep txt */
      }
      throw new Error(detail);
    }

    appendLog("SSE 连接已建立", "ok");
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamTimings = {};

    const handleBlock = (block) => {
      const parsed = parseSseBlock(block);
      if (!parsed) return;
      if (parsed.event === "log") {
        appendSseLog(parsed.data);
      } else if (parsed.event === "route_delta") {
        if (!streamRouteRaw && !$("#routeRawStream")) {
          appendLog("路由模型开始流式输出", "route");
          $("#routeBox").innerHTML = `
            <div class="routeRaw">
              <div class="routeRawHead">路由模型输出（流式）</div>
              <pre id="routeRawStream" class="routeRawBody"></pre>
            </div>
            <div class="routeList"><div class="empty">等待路由 JSON 解析…</div></div>
          `;
        }
        if (parsed.data.route_first_token_ms != null) {
          streamTimings.route_first_token_ms = parsed.data.route_first_token_ms;
          updateRouteStreamTimings(streamTimings);
          appendLog(`[前端] 路由首字 · ${fmtMs(parsed.data.route_first_token_ms)}`, "route");
        }
        appendStreamingRoute(parsed.data.content || "");
      } else if (parsed.event === "route") {
        streamTimings = {
          route_ms: parsed.data.route_ms,
          route_first_token_ms: parsed.data.route_first_token_ms ?? streamTimings.route_first_token_ms,
        };
        updateRouteStreamTimings(streamTimings);
        if (parsed.data.route_raw) streamRouteRaw = parsed.data.route_raw;
        const targets = parsed.data.target_agents || [];
        appendLog(
          `[前端] 路由事件 · ${fmtMs(parsed.data.route_ms)} · ${targets.length} 个 agent`,
          "route"
        );
        logRouteTargets(targets);
        if (streamRouteRaw) appendLogBlock("路由 JSON", streamRouteRaw, "route");
        renderStreamingShell(parsed.data);
      } else if (parsed.event === "delta") {
        if (parsed.data.first_token_ms != null) {
          streamTimings.first_token_ms = parsed.data.first_token_ms;
          updateStreamTimings(streamTimings);
          appendLog(`[前端] 回答首字 · ${fmtMs(parsed.data.first_token_ms)}`, "ok");
        }
        if (!logAnswerStreamEl && parsed.data.content) {
          appendLog("回答模型开始流式输出", "ok");
        }
        appendStreamingAnswer(parsed.data.content || "");
      } else if (parsed.event === "done") {
        if (parsed.data?.timings) streamTimings = { ...streamTimings, ...parsed.data.timings };
        const t = streamTimings;
        appendLog(
          `[前端] done · 总 ${fmtMs(t.total_ms)} · 路由首字 ${fmtMs(t.route_first_token_ms)} · 回答首字 ${fmtMs(t.first_token_ms)}`,
          "ok"
        );
        logDoneDetails(parsed.data);
        renderRoute({
          ...parsed.data,
          route_raw: streamRouteRaw || parsed.data.route_raw || "",
          timings: streamTimings,
        });
        renderAnswers(parsed.data);
        updateTimingBar(streamTimings, parsed.data);
      } else if (parsed.event === "error") {
        appendLog(`SSE 错误: ${parsed.data.detail || "流式请求失败"}`, "err");
        throw new Error(parsed.data.detail || "流式请求失败");
      } else {
        appendLog(`[SSE] 未处理事件: ${parsed.event}`, "warn");
        appendLogBlock(parsed.event, parsed.data, "warn");
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        if (part.trim()) handleBlock(part);
      }
    }
    if (buffer.trim()) handleBlock(buffer);
  } catch (e) {
    appendLog(`请求失败: ${e?.message || e}`, "err");
    renderRoute({
      need_clarification: true,
      clarification_question: `请求失败：${e?.message || e}`,
    });
    renderAnswers({
      need_clarification: true,
      clarification_question: `请求失败：${e?.message || e}`,
    });
  } finally {
    btn.disabled = false;
    btn.textContent = "提问";
  }
}

function switchLeftTab(name) {
  $$("[data-left-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.leftTab === name);
  });
  $("#leftTabAnswer").classList.toggle("active", name === "answer");
  $("#leftTabRoute").classList.toggle("active", name === "route");
}

function switchRightTab(name) {
  $$("[data-right-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.rightTab === name);
  });
  $("#rightTabLog").classList.toggle("active", name === "log");
  $("#rightTabFiles").classList.toggle("active", name === "files");
  const actions = $("#rightTabActions");
  if (actions) actions.style.display = name === "log" ? "" : "none";
}

async function loadRouteQuestionsPool() {
  try {
    await loadAllCaches();
    const routerId = getSelectedRouterIdFrom($("#routerSelect"));
    const agents = agentsForRouter(routerId);
    const pool = [];
    for (const cfg of Object.values(agents || {})) {
      for (const q of cfg.route_questions || []) {
        if (typeof q === "string" && q.trim()) pool.push(q.trim());
      }
    }
    routeQuestionsPool = pool;
  } catch (e) {
    routeQuestionsPool = [];
    appendLog(`加载随机问题池失败: ${e?.message || e}`, "err");
  }
}

async function pickRandomQuestion() {
  if (!routeQuestionsPool.length) {
    await loadRouteQuestionsPool();
  }
  if (!routeQuestionsPool.length) {
    appendLog("暂无可用随机问题（请先在管理页初始化 agent 生成 route_questions）", "warn");
    return;
  }
  const q = routeQuestionsPool[Math.floor(Math.random() * routeQuestionsPool.length)];
  const ta = $("#question");
  if (ta) {
    ta.value = q;
    ta.focus();
  }
  appendLog(`随机问题：${q}`, "info");
}

function bindTest() {
  initFilePanel("test", {
    select: "#fileSelect",
    preview: "#filePreviewBox",
    source: "#fileSourceBox",
    previewBtn: "#filePreviewBtn",
    sourceBtn: "#fileSourceBtn",
    onError: (msg) => appendLog(msg, "err"),
  });
  bindFilePanel("test");

  $("#answerPreviewBtn")?.addEventListener("click", () => setAnswerViewMode("preview"));
  $("#answerSourceBtn")?.addEventListener("click", () => setAnswerViewMode("source"));
  bindAnswerImageZoom();

  $("#askBtn").addEventListener("click", ask);
  $("#clearBtn").addEventListener("click", () => {
    $("#question").value = "";
    resetStreamingRoute();
    renderRoute(null);
    renderAnswers(null);
  });
  $("#randomQuestionBtn")?.addEventListener("click", () => {
    pickRandomQuestion().catch((e) => appendLog(e?.message || e, "err"));
  });
  $("#clearLogBtn").addEventListener("click", clearLogs);
  $("#question").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      ask();
    }
  });

  $$("[data-left-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchLeftTab(btn.dataset.leftTab));
  });
  $$("[data-right-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchRightTab(btn.dataset.rightTab));
  });
  $("#routerSelect")?.addEventListener("change", () => {
    refreshTestPageSideData();
  });
}

bindTest();
appendLog("控制台已加载");
loadAllCaches()
  .then(() => populateRouterSelect($("#routerSelect")))
  .then(() => refreshTestPageSideData())
  .catch(() => refreshTestPageSideData());
