"use strict";

const $ = (id) => document.getElementById(id);
const apiGet = (p) => fetch(p).then(handleResponse);
const apiPost = (p, body) =>
  fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(handleResponse);
const apiPut = (p, body) =>
  fetch(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(handleResponse);
function handleResponse(r) {
  if (!r.ok) return r.text().then((t) => Promise.reject(new Error(t || r.statusText)));
  return r.json();
}
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escapeAttr = (s) => escapeHtml(s);

let config = null;

document.addEventListener("DOMContentLoaded", () => {
  bindMenu();
  bindQa();
  bindEval();
  bindModal();
  bindEvalDetailModal();
  bindParams();
  loadHealth();
  loadConfig();
});

/* ===== 菜单切换 ===== */
function bindMenu() {
  document.querySelectorAll(".menu-item").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.classList.contains("muted")) return;
      const tab = el.dataset.tab;
      const panel = $(tab + "Panel");
      if (!panel) return;
      document.querySelectorAll(".menu-item").forEach((m) => m.classList.remove("active"));
      el.classList.add("active");
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      panel.classList.add("active");
      closeEvalDetailModal();
    });
  });
}

/* ===== 健康检查 ===== */
async function loadHealth() {
  try {
    const h = await apiGet("/api/health");
    const idx = h.index || {};
    const el = $("indexStatus");
    if (idx.stale) {
      el.innerHTML = '索引已过期，<a href="#" id="rebuildLink" style="color:var(--warn)">建议重建</a>';
      $("rebuildLink").addEventListener("click", (e) => { e.preventDefault(); rebuildIndex(); });
    } else if (idx.ready) {
      el.textContent = "索引就绪 ✓";
      el.style.borderColor = "rgba(109, 175, 120, 0.4)";
    } else {
      el.textContent = "索引不存在，请先构建索引";
      el.style.borderColor = "rgba(201, 114, 106, 0.4)";
    }
  } catch (e) {
    $("indexStatus").textContent = "服务不可用";
  }
}
async function rebuildIndex() {
  $("indexStatus").textContent = "重建中…";
  try {
    await apiPost("/api/index/rebuild");
    loadHealth();
  } catch (e) {
    showError(e.message);
  }
}

/* ===== 问答 ===== */
function bindQa() {
  const input = $("queryInput");
  $("chatBtn").addEventListener("click", () => runChat(input.value));
  $("searchBtn").addEventListener("click", () => runSearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runChat(input.value);
  });
}

const TIMING_LABELS = {
  embedding_ms: "Embedding 向量化",
  vector_lookup_ms: "FAISS 向量检索",
  keyword_search_ms: "关键词检索",
  fusion_ms: "RRF 融合",
  rerank_ms: "Rerank 重排",
  generate_ms: "LLM 生成回答",
  judge_ms: "LLM Judge 评测",
  search_ms: "检索小计",
  total_ms: "总耗时",
};

const TIMING_ORDER_CHAT = [
  "embedding_ms",
  "vector_lookup_ms",
  "keyword_search_ms",
  "fusion_ms",
  "rerank_ms",
  "generate_ms",
  "total_ms",
];

const TIMING_ORDER_EVAL = [
  "embedding_ms",
  "vector_lookup_ms",
  "keyword_search_ms",
  "fusion_ms",
  "rerank_ms",
  "generate_ms",
  "judge_ms",
  "total_ms",
];

const TIMING_SHORT = {
  embedding_ms: "向量",
  vector_lookup_ms: "FAISS",
  keyword_search_ms: "词搜",
  fusion_ms: "融合",
  rerank_ms: "重排",
  generate_ms: "生成",
  judge_ms: "Judge",
  search_ms: "检索",
  total_ms: "总",
};

function formatTiming(v, unit) {
  if (v == null || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  if (unit === "s") return (n / 1000).toFixed(2) + "s";
  return n.toFixed(1) + "ms";
}

function timingMs(v) {
  return formatTiming(v, "ms");
}

function timingSec(v) {
  return formatTiming(v, "s");
}

function renderQaTiming(el, timing) {
  if (!el) return;
  if (!timing || !timing.total_ms) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const chips = [];
  TIMING_ORDER_CHAT.forEach((key) => {
    if (!(key in timing)) return;
    const val = timing[key];
    if (key !== "total_ms" && val === 0) return;
    const isTotal = key === "total_ms";
    chips.push(
      '<span class="qa-timing-chip' + (isTotal ? " total" : "") + '">' +
      escapeHtml((TIMING_SHORT[key] || key) + " " + timingSec(val)) +
      "</span>"
    );
  });
  el.innerHTML = chips.join("");
  el.classList.remove("hidden");
}

function renderTimingPanel(el, timing, opts) {
  if (!el) return;
  if (!timing || !Object.keys(timing).length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const unit = (opts && opts.unit) || "ms";
  const fmt = unit === "s" ? timingSec : timingMs;
  const order = opts && opts.eval ? TIMING_ORDER_EVAL : TIMING_ORDER_CHAT;
  const title = (opts && opts.title) || "";
  const isAvg = !!(opts && opts.average);
  let html = "";
  if (title || isAvg) {
    html += '<div class="timing-head"><span class="timing-title">' + escapeHtml(title || "耗时") + "</span>";
    if (isAvg) html += '<span class="timing-note">各步骤平均</span>';
    html += "</div>";
  }
  html += '<div class="timing-steps">';
  order.forEach((key) => {
    if (!(key in timing)) return;
    const val = timing[key];
    if (key !== "total_ms" && val === 0) return;
    const isTotal = key === "total_ms";
    html +=
      '<div class="timing-step' + (isTotal ? " total" : "") + '">' +
      '<span class="timing-label">' + escapeHtml(TIMING_LABELS[key] || key) + "</span>" +
      '<span class="timing-value">' + fmt(val) + "</span></div>";
  });
  html += "</div>";
  el.classList.remove("hidden");
  el.innerHTML = html;
}

function timingSectionHtml(timing, opts) {
  if (!timing || !Object.keys(timing).length) return "";
  const unit = (opts && opts.unit) || "s";
  const fmt = unit === "s" ? timingSec : timingMs;
  const order = opts && opts.eval ? TIMING_ORDER_EVAL : TIMING_ORDER_CHAT;
  let rows = "";
  order.forEach((key) => {
    if (!(key in timing)) return;
    const val = timing[key];
    if (key !== "total_ms" && val === 0) return;
    const isTotal = key === "total_ms";
    rows +=
      '<div class="timing-step' + (isTotal ? " total" : "") + '">' +
      '<span class="timing-label">' + escapeHtml(TIMING_LABELS[key] || key) + "</span>" +
      '<span class="timing-value">' + fmt(val) + "</span></div>";
  });
  return '<section class="eval-block"><h4>耗时统计（秒）</h4><div class="timing-steps">' + rows + "</div></section>";
}

async function runSearch(q) {
  q = (q || "").trim();
  if (!q) return;
  $("searchBtn").disabled = true;
  try {
    const topK = config && config.top_k ? config.top_k : 8;
    const data = await apiPost("/api/search", { query: q, top_k: topK });
    renderSources(data.results || []);
    renderAnswer({ answer: "", mode: "search-only", confidence: null, images: [], timing: data.timing });
    renderQaTiming($("qaTiming"), data.timing);
    $("modePill").textContent = "search";
    $("debugJson").textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    showError(e.message);
  } finally {
    $("searchBtn").disabled = false;
  }
}

async function runChat(q) {
  q = (q || "").trim();
  if (!q) return;
  $("chatBtn").disabled = true;
  $("answerBox").classList.add("empty");
  $("answerBox").textContent = "思考中…";
  try {
    const topN = config && config.top_n ? config.top_n : 3;
    const data = await apiPost("/api/chat", { query: q, top_n: topN });
    renderSources(data.sources || []);
    renderAnswer(data);
    renderQaTiming($("qaTiming"), data.timing);
    $("modePill").textContent = data.mode || "direct";
    $("resultCount").textContent = (data.sources || []).length + " 条候选";
    $("debugJson").textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    showError(e.message);
    $("answerBox").textContent = "请求失败：" + e.message;
  } finally {
    $("chatBtn").disabled = false;
  }
}

function renderAnswer(data) {
  const box = $("answerBox");
  if (!data || (!data.answer && data.mode !== "search-only")) {
    box.classList.add("empty");
    box.textContent = "发起问答后，这里展示大模型的回答。";
    renderQaTiming($("qaTiming"), null);
    return;
  }
  box.classList.remove("empty");
  if (data.mode === "search-only") {
    box.classList.add("empty");
    box.textContent = "已展示检索结果，点击右侧条目查看详情。";
    if (data.timing) renderQaTiming($("qaTiming"), data.timing);
  } else {
    box.innerHTML = renderMarkdown(data.answer || "");
  }
  const conf = data.confidence;
  const pill = $("confidencePill");
  if (typeof conf === "number") {
    pill.textContent = "置信度 " + (conf * 100).toFixed(1) + "%";
    pill.className = "pill " + (conf >= 0.4 ? "ok" : conf > 0 ? "bad" : "muted");
  } else {
    pill.textContent = "置信度 -";
    pill.className = "pill muted";
  }
  // 顶部答案内联图片
  if (data.images && data.images.length) {
    const wrap = document.createElement("div");
    wrap.className = "answer-images";
    data.images.forEach((img) => wrap.appendChild(imageThumb(img)));
    box.appendChild(wrap);
  }
}

function renderSources(sources) {
  const list = $("sourcesList");
  const nav = $("navList");
  $("sourcesCount").textContent = sources.length;
  if (!sources.length) {
    list.className = "sources-list empty";
    list.textContent = "未检索到相关 FAQ。";
    nav.className = "nav-list empty";
    nav.textContent = "无条目";
    return;
  }
  list.className = "sources-list";
  nav.className = "nav-list";
  list.innerHTML = "";
  nav.innerHTML = "";
  sources.forEach((src, i) => {
    const id = "src-" + (src.id || i);
    const item = document.createElement("div");
    item.className = "source-item";
    item.id = id;
    const variants = Array.isArray(src.variants) ? src.variants : [];
    const variantHtml = variants.length
      ? '<div class="si-variants"><span class="si-label">相似问法</span>' +
        variants.map((v) => '<span class="si-variant">' + escapeHtml(typeof v === "string" ? v : v.variant || "") + "</span>").join("") +
        "</div>"
      : "";
    const matchedTypes = Array.isArray(src.matched_doc_types) ? src.matched_doc_types : [];
    const imgs = Array.isArray(src.images) ? src.images : [];
    const imgHtml = imgs.length
      ? '<div class="si-images"><span class="si-label">图片 (' + imgs.length + ")</span>" +
        imgs.map((im) => '<img src="' + escapeAttr(normalizeImageUrl(im.url || im.src)) + '" alt="' + escapeAttr(im.alt || "") + '"' + (im.exists === false ? ' class="missing"' : "") + " />").join("") +
        "</div>"
      : "";
    const scores =
      '<span class="si-scores">' +
      (src.rerank_score != null ? '<span class="si-score">rerank ' + scoreFmt(src.rerank_score) + "</span>" : "") +
      '<span class="si-score">rrf ' + scoreFmt(src.rrf_score) + "</span>" +
      '<span class="si-score">vec ' + scoreFmt(src.vector_score) + "</span>" +
      '<span class="si-score">kw ' + scoreFmt(src.keyword_score) + "</span>" +
      (matchedTypes.length ? '<span class="si-score">命中 ' + escapeHtml(matchedTypes.join("/")) + "</span>" : "") +
      "</span>";
    const meta =
      '<div class="si-meta">' +
      '<span class="si-id">ID #' + escapeHtml(src.id ?? "") + "</span>" +
      (src.updated_at ? '<span class="si-date">更新 ' + escapeHtml(String(src.updated_at).slice(0, 19)) + "</span>" : "") +
      "</div>";
    item.innerHTML =
      '<div class="si-head"><span class="si-q">' + escapeHtml("#" + (i + 1) + " " + (src.question || "")) + "</span>" + scores + "</div>" +
      meta +
      '<div class="si-body">' + renderMarkdown(src.answer || "") + "</div>" +
      variantHtml +
      imgHtml;
    // attach image click handlers for full preview
    item.querySelectorAll(".si-images img").forEach((im) => {
      im.addEventListener("click", () => openModal(im.src, im.alt));
    });
    list.appendChild(item);

    const navItem = document.createElement("div");
    navItem.className = "nav-item";
    navItem.innerHTML = '<span class="ni-rank">' + (i + 1) + '</span><span class="ni-q">' + escapeHtml(src.question || "") + "</span>";
    navItem.addEventListener("click", () => {
      item.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelectorAll(".source-item").forEach((s) => s.classList.remove("highlight"));
      item.classList.add("highlight");
    });
    nav.appendChild(navItem);
  });
}

function scoreFmt(v) {
  if (v == null) return "-";
  return (typeof v === "number" ? v : parseFloat(v)).toFixed(3);
}

/* ===== 图片 ===== */
function imageThumb(img) {
  const wrap = document.createElement("span");
  wrap.style.display = "inline-block";
  const im = document.createElement("img");
  im.src = normalizeImageUrl(img.url || img.src);
  im.alt = img.alt || "";
  im.style.maxWidth = "120px";
  im.style.borderRadius = "6px";
  im.style.margin = "4px";
  im.style.cursor = "zoom-in";
  if (img.exists === false) {
    im.style.opacity = "0.4";
    im.title = "文件缺失：" + (img.src || "");
  }
  im.addEventListener("click", () => openModal(im.src, img.alt || ""));
  wrap.appendChild(im);
  return wrap;
}
function normalizeImageUrl(u) {
  if (!u) return "";
  if (u.startsWith("http") || u.startsWith("/") || u.startsWith("data:")) return u;
  return "/assets/" + u.replace(/^assets\/?/, "");
}

/* ===== 评测 ===== */
const EVAL_MODES = {
  mixed: "混合模式：主问题 + 未入索引的相似问法合并抽样，贴近真实用户提问分布。",
  holdout_variant: "预留相似问法：测试句故意未建索引，不能靠原句匹配刷分，指标最可信。",
  question: "主问题模式：用 FAQ 主问题原文测试，召回最容易，适合冒烟与基线。",
  indexed_variant: "已索引相似问法：用已写入索引的 variants 测试，比主问题略难。",
};

function bindEval() {
  document.querySelectorAll("[data-eval-size]").forEach((btn) => {
    btn.addEventListener("click", () => startEval(parseInt(btn.dataset.evalSize, 10)));
  });
  const modeSel = $("evalMode");
  modeSel.addEventListener("change", () => updateEvalModeUi(modeSel.value));
  updateEvalModeUi(modeSel.value);
  loadEvalHistory();
}

function updateEvalModeUi(mode) {
  $("evalModeHint").textContent = (EVAL_MODES[mode] || "") + " 每次从候选池随机抽取指定数量。";
  document.querySelectorAll(".mode-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.mode === mode);
  });
}
async function startEval(size) {
  $("evalStatus").textContent = "运行中…";
  $("evalStatus").className = "pill";
  try {
    const { run_id } = await apiPost("/api/eval/run", { size, mode: $("evalMode").value });
    pollEval(run_id);
  } catch (e) {
    showError(e.message);
    $("evalStatus").textContent = "失败";
  }
}
async function pollEval(runId) {
  const tick = async () => {
    try {
      const run = await apiGet("/api/eval/runs/" + runId);
      renderEvalRun(run);
      if (run.status === "running") setTimeout(tick, 1500);
    } catch (e) {
      $("evalStatus").textContent = "查询失败";
    }
  };
  tick();
}
function renderEvalRun(run) {
  const s = run.summary || {};
  const done = s.processed || 0;
  const m = $("evalSummary").children;
  m[0].querySelector("b").textContent = done + "/" + (run.total || 0);
  m[1].querySelector("b").textContent = pct(s.recall_at_1);
  m[2].querySelector("b").textContent = pct(s.recall_at_5);
  m[3].querySelector("b").textContent = (s.avg_quality || 0).toFixed(2);
  m[4].querySelector("b").textContent = (s.avg_confidence || 0).toFixed(2);
  renderTimingPanel($("evalTimingSummary"), s.avg_timing_ms, {
    title: "",
    average: true,
    eval: true,
    unit: "s",
  });
  const avgT = s.avg_timing_ms || {};
  const timingDetails = $("evalTimingDetails");
  const timingLine = $("evalTimingSummaryLine");
  if (avgT && avgT.total_ms) {
    timingDetails.classList.remove("hidden");
    timingLine.textContent =
      "平均耗时 · 总 " + timingSec(avgT.total_ms) +
      (avgT.search_ms ? " · 检索 " + timingSec(avgT.search_ms) : "") +
      (avgT.generate_ms ? " · 生成 " + timingSec(avgT.generate_ms) : "") +
      " · 点击展开各步骤";
  } else {
    timingDetails.classList.add("hidden");
  }
  $("evalStatus").textContent = run.status === "completed" ? "已完成" : run.status === "running" ? "运行中" : run.status || "";
  $("evalStatus").className = "pill " + (run.status === "completed" ? "ok" : run.status === "failed" ? "bad" : "");
  const box = $("evalResults");
  box.className = "eval-results";
  box.innerHTML = "";
  (run.results || []).forEach((r, i) => box.appendChild(evalItem(r, i + 1, run.mode)));
  if (run.status === "completed") loadEvalHistory();
}

function evalItem(r, index, runMode) {
  const detail = r.result || {};
  const sampleType = detail.sample_type || runMode || "-";
  const query = r.query || detail.query || "";
  const systemAnswer = detail.answer || r.answer || "";
  const itemTiming = detail.timing || {};
  const el = document.createElement("article");
  el.className = "eval-item-compact" + (r.hit_top1 ? " eval-hit" : " eval-miss");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", "查看第 " + index + " 条评测详情");

  const hit1 = r.hit_top1 ? "命中" : "未中";
  const timingShort = itemTiming.total_ms != null ? " · " + timingSec(itemTiming.total_ms) : "";

  el.innerHTML =
    '<div class="eval-compact-head">' +
    '<div class="eval-item-title"><span class="eval-idx">#' + index + "</span>" +
    '<span class="eval-sample-type">' + escapeHtml(sampleTypeLabel(sampleType)) + "</span></div>" +
    '<div class="eval-item-badges">' +
    badge("R@1 " + hit1, r.hit_top1) +
    badge("质量 " + scoreFmt(r.quality_score), r.quality_score >= 0.6) +
    "</div></div>" +
    '<p class="eval-compact-query">' + escapeHtml(query) + "</p>" +
    '<p class="eval-compact-meta">预期 ' + escapeHtml(r.expected_item_id || detail.expected_item_id || "-") +
    " → 实际 " + escapeHtml(r.actual_item_id || detail.actual_item_id || "无") + timingShort + "</p>" +
    (systemAnswer
      ? '<p class="eval-compact-preview">' + escapeHtml(stripPlain(systemAnswer).slice(0, 160)) + (stripPlain(systemAnswer).length > 160 ? "…" : "") + "</p>"
      : "") +
    '<div class="eval-compact-foot"><span class="eval-open-hint">点击查看完整详情</span></div>';

  const open = () => openEvalDetail(r, index, runMode);
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return el;
}

function stripPlain(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "[图]")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*`_|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEvalDetailHtml(r, index, runMode) {
  const detail = r.result || {};
  const sampleType = detail.sample_type || runMode || "-";
  const hit1 = r.hit_top1 ? "命中" : "未中";
  const hit3 = r.hit_top3 ? "命中" : "未中";
  const hit5 = r.hit_top5 ? "命中" : "未中";
  const sources = detail.sources || [];
  const expectedAnswer = detail.expected_answer || "";
  const systemAnswer = detail.answer || r.answer || "";
  const expectedQ = detail.expected_question || "";
  const itemTiming = detail.timing || {};
  const query = r.query || detail.query || "";

  const sourcesHtml = sources.length
    ? sources.map((src, i) =>
        '<article class="eval-src">' +
        '<div class="eval-src-head"><span class="eval-src-rank">#' + (i + 1) + "</span>" +
        '<span class="eval-src-id">' + escapeHtml(src.id || "") + "</span>" +
        '<span class="eval-src-score">rerank ' + scoreFmt(src.rerank_score) +
        " · rrf " + scoreFmt(src.rrf_score) +
        " · vec " + scoreFmt(src.vector_score) +
        " · kw " + scoreFmt(src.keyword_score) + "</span></div>" +
        '<div class="eval-src-q">' + escapeHtml(src.question || "") + "</div>" +
        '<div class="eval-src-body">' + renderMarkdown(src.answer || "") + "</div></article>"
      ).join("")
    : '<p class="hint">无检索来源</p>';

  return (
    '<h2 id="evalDetailTitle" class="eval-detail-title">#' + index + " · " + escapeHtml(query) + "</h2>" +
    '<div class="eval-item-badges" style="margin-bottom:14px">' +
    badge("类型 " + sampleTypeLabel(sampleType), true) +
    badge("R@1 " + hit1, r.hit_top1) +
    badge("R@3 " + hit3, r.hit_top3) +
    badge("R@5 " + hit5, r.hit_top5) +
    badge("图片", r.image_hit) +
    badge("质量 " + scoreFmt(r.quality_score), r.quality_score >= 0.6) +
    (itemTiming.total_ms != null ? badge("总 " + timingSec(itemTiming.total_ms), true) : "") +
    "</div>" +
    timingSectionHtml(itemTiming, { eval: true, unit: "s" }) +
    '<section class="eval-block eval-grid-2">' +
    '<div><h4>预期 FAQ</h4><p class="eval-meta-line"><span>ID</span> ' + escapeHtml(r.expected_item_id || detail.expected_item_id || "-") + "</p>" +
    (expectedQ ? '<p class="eval-meta-line"><span>主问题</span> ' + escapeHtml(expectedQ) + "</p>" : "") +
    "</div>" +
    '<div><h4>实际命中</h4><p class="eval-meta-line"><span>Top-1</span> ' + escapeHtml(r.actual_item_id || detail.actual_item_id || "无") + "</p>" +
    '<p class="eval-meta-line"><span>检索序列</span> ' + escapeHtml((detail.retrieved_ids || []).join(" → ") || "-") + "</p></div>" +
    "</section>" +
    '<section class="eval-block"><h4>标准答案</h4><div class="eval-answer expected">' +
    (expectedAnswer ? renderMarkdown(expectedAnswer) : '<span class="hint">（历史记录可能未保存，请重新运行评测）</span>') +
    "</div></section>" +
    '<section class="eval-block"><h4>系统回答</h4><div class="eval-answer actual">' +
    (systemAnswer ? renderMarkdown(systemAnswer) : '<span class="hint">无回答</span>') +
    "</div></section>" +
    '<section class="eval-block"><h4>检索文档详情（' + sources.length + " 条）</h4><div class=\"eval-sources\">" + sourcesHtml + "</div></section>" +
    '<section class="eval-block eval-judge"><h4>Judge 评语</h4>' +
    '<div class="eval-judge-scores">' +
    '<span>质量 ' + scoreFmt(r.quality_score) + "</span>" +
    '<span>置信度 ' + scoreFmt(r.confidence) + "</span>" +
    '<span>groundedness ' + scoreFmt(r.groundedness) + "</span>" +
    '<span>图片支撑 ' + scoreFmt(r.image_support) + "</span>" +
    "</div>" +
    '<p class="eval-reason">' + escapeHtml(r.reason || "无评语") + "</p>" +
    (r.judge_error ? '<p class="eval-error">Judge 异常：' + escapeHtml(r.judge_error) + "</p>" : "") +
    "</section>"
  );
}

function openEvalDetail(r, index, runMode) {
  const body = $("evalDetailBody");
  body.innerHTML = buildEvalDetailHtml(r, index, runMode);
  body.querySelectorAll("img").forEach((im) => {
    im.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(im.src, im.alt);
    });
  });
  $("evalDetailModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeEvalDetailModal() {
  $("evalDetailModal").setAttribute("aria-hidden", "true");
  $("evalDetailBody").innerHTML = "";
  document.body.style.overflow = "";
}

function bindEvalDetailModal() {
  document.querySelectorAll("[data-close-eval]").forEach((el) => {
    el.addEventListener("click", closeEvalDetailModal);
  });
}

function sampleTypeLabel(t) {
  const map = {
    question: "主问题",
    indexed_variant: "已索引相似问法",
    holdout_variant: "预留相似问法",
    mixed: "混合",
  };
  return map[t] || t;
}

function badge(text, ok) {
  return '<span class="eval-badge ' + (ok ? "ok" : "bad") + '">' + escapeHtml(text) + "</span>";
}
async function loadEvalHistory() {
  try {
    const { runs } = await apiGet("/api/eval/runs?limit=8");
    const box = $("evalHistory");
    box.innerHTML = "";
    runs.forEach((r) => {
      const el = document.createElement("div");
      el.className = "history-item";
      el.innerHTML = escapeHtml(
        (r.created_at || "").slice(0, 19) + " · " + (r.mode || "?") + " · " + (r.size || 0) + "题 · " + (r.status || "")
      );
      el.addEventListener("click", () => pollEval(r.run_id));
      box.appendChild(el);
    });
  } catch (e) {}
}

/* ===== 模型参数 ===== */
function bindParams() {
  $("saveParams").addEventListener("click", saveParams);
  $("saveTpl").addEventListener("click", saveTemplate);
  $("addTemplate").addEventListener("click", addTemplate);
  $("enableTpl").addEventListener("click", enableTemplate);
  $("deleteTpl").addEventListener("click", deleteTemplate);
  $("tplSelect").addEventListener("change", loadTemplateFields);
}
async function loadConfig() {
  try {
    config = await apiGet("/api/config");
    fillParamsForm(config);
  } catch (e) {
    showError("加载配置失败：" + e.message);
  }
}
function fillParamsForm(c) {
  config = c;
  $("cfgTemperature").value = c.temperature;
  $("cfgTopK").value = c.top_k;
  $("cfgTopN").value = c.top_n;
  $("cfgMinConf").value = c.min_confidence_score;
  $("cfgAnswerMode").value = c.answer_mode;
  $("cfgUseRerank").checked = c.use_rerank;
  const sel = $("tplSelect");
  sel.innerHTML = "";
  (c.templates || []).forEach((t) => {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = (t.id === c.active_template_id ? "● " : "") + (t.name || t.id);
    sel.appendChild(o);
  });
  sel.value = c.active_template_id;
  loadTemplateFields();
}
function loadTemplateFields() {
  const id = $("tplSelect").value;
  const t = (config.templates || []).find((x) => x.id === id);
  if (!t) return;
  $("tplName").value = t.name || "";
  $("tplContent").value = t.content || "";
  $("tplActiveHint").textContent =
    id === config.active_template_id ? "当前启用：" + (t.name || t.id) : "未启用（当前启用：" + (config.active_template_id) + "）";
}
async function saveParams() {
  const body = {
    temperature: parseFloat($("cfgTemperature").value),
    top_k: parseInt($("cfgTopK").value, 10),
    top_n: parseInt($("cfgTopN").value, 10),
    min_confidence_score: parseFloat($("cfgMinConf").value),
    answer_mode: $("cfgAnswerMode").value,
    use_rerank: $("cfgUseRerank").checked,
  };
  try {
    config = await apiPut("/api/config", body);
    fillParamsForm(config);
    $("paramsSaved").hidden = false;
    setTimeout(() => ($("paramsSaved").hidden = true), 1800);
  } catch (e) {
    showError(e.message);
  }
}
async function saveTemplate() {
  const id = $("tplSelect").value;
  const name = $("tplName").value.trim() || id;
  const content = $("tplContent").value;
  const templates = (config.templates || []).map((t) =>
    t.id === id ? { id: t.id, name, content } : t
  );
  try {
    $("saveTpl").disabled = true;
    config = await apiPut("/api/config", { templates });
    fillParamsForm(config);
    $("tplSelect").value = id;
    loadTemplateFields();
    $("tplSaved").hidden = false;
    setTimeout(() => ($("tplSaved").hidden = true), 1800);
    return true;
  } catch (e) {
    showError(e.message);
    return false;
  } finally {
    $("saveTpl").disabled = false;
  }
}
async function addTemplate() {
  let base = "tpl_" + Date.now().toString(36).slice(-4);
  const t = { id: base, name: "新模板", content: "你是相机 FAQ 助手。请根据 FAQ 来源回答用户问题。\n\n用户问题：{query}\n\nFAQ 来源：\n{context}" };
  const templates = [...(config.templates || []), t];
  try {
    config = await apiPut("/api/config", { templates, active_template_id: config.active_template_id });
    fillParamsForm(config);
    $("tplSelect").value = base;
    loadTemplateFields();
  } catch (e) {
    showError(e.message);
  }
}
async function enableTemplate() {
  const id = $("tplSelect").value;
  await saveTemplate();
  try {
    config = await apiPut("/api/config", { active_template_id: id });
    fillParamsForm(config);
    $("tplSelect").value = id;
    loadTemplateFields();
  } catch (e) {
    showError(e.message);
  }
}
async function deleteTemplate() {
  const id = $("tplSelect").value;
  if (config.templates.length <= 1) {
    showError("至少保留一个模板");
    return;
  }
  const templates = (config.templates || []).filter((t) => t.id !== id);
  const patch = { templates };
  if (config.active_template_id === id) patch.active_template_id = templates[0].id;
  try {
    config = await apiPut("/api/config", patch);
    fillParamsForm(config);
  } catch (e) {
    showError(e.message);
  }
}

/* ===== Modal ===== */
function bindModal() {
  document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModal));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const evalModal = $("evalDetailModal");
    if (evalModal && evalModal.getAttribute("aria-hidden") === "false") {
      closeEvalDetailModal();
      return;
    }
    closeModal();
  });
}
function openModal(src, caption) {
  $("modalImage").src = src;
  $("modalCaption").textContent = caption || "";
  $("imageModal").setAttribute("aria-hidden", "false");
}
function closeModal() {
  $("imageModal").setAttribute("aria-hidden", "true");
  $("modalImage").src = "";
}

function showError(msg) {
  const box = $("answerBox");
  if (box) {
    box.classList.remove("empty");
    box.innerHTML = '<p style="color:var(--bad)">⚠ ' + escapeHtml(msg) + "</p>";
  } else {
    alert(msg);
  }
}
function pct(v) {
  if (v == null) return "-";
  return (v * 100).toFixed(0) + "%";
}

/* ===== 简易 Markdown 渲染（保留图片） ===== */
function renderMarkdown(md, compact) {
  if (!md) return "";
  let s = escapeHtml(md);
  // images
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) =>
    '<img src="' + escapeAttr(normalizeImageUrl(src)) + '" alt="' + escapeAttr(alt) + '" />'
  );
  // links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // headings
  s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>");
  // bold / italic / code
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  // lists
  s = s.replace(/^(?:- |\* )(.*)$/gm, "<li>$1</li>");
  s = s.replace(/(<li>[\s\S]*?<\/li>)/g, (m) => "<ul>" + m.replace(/<\/li>\s*<li>/g, "</li><li>") + "</ul>");
  // tables (basic)
  if (s.includes("|")) s = renderTable(s);
  // paragraphs
  s = s.replace(/\n{2,}/g, "</p><p>");
  s = "<p>" + s + "</p>";
  s = s.replace(/<p>(<h[1-3]>)/g, "$1").replace(/(<\/h[1-3]>)<\/p>/g, "$1");
  s = s.replace(/<p>(<ul>)/g, "$1").replace(/(<\/ul>)<\/p>/g, "$1");
  s = s.replace(/<p>(<table>)/g, "$1").replace(/(<\/table>)<\/p>/g, "$1");
  if (compact) {
    s = s.replace(/<h[1-3]>.*?<\/h[1-3]>/g, "");
  }
  return s;
}
function renderTable(s) {
  const lines = s.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return s;
  let out = "<table>";
  lines.forEach((line, i) => {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (i === 1 && cells.every((c) => /^[-: ]+$/.test(c))) return;
    const tag = i === 0 ? "th" : "td";
    out += "<tr>" + cells.map((c) => "<" + tag + ">" + c + "</" + tag + ">").join("") + "</tr>";
  });
  return out + "</table>";
}
