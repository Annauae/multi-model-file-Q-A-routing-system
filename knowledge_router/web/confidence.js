let confLogLines = [];
let confQuestionsCache = [];
let confCandidates = [];
let confSelectedCandidateId = "";

function confLogKind(line) {
  if (line.startsWith("[step]")) return "step";
  if (line.startsWith("[cache]")) return "cache";
  if (line.startsWith("[prompt]")) return "prompt";
  if (line.startsWith("[match]")) return "match";
  if (line.startsWith("[parse]")) return "parse";
  if (line.startsWith("[lookup]")) return "lookup";
  if (line.startsWith("[timing]")) return "timing";
  if (line.startsWith("ERROR")) return "error";
  return "log";
}

function confAppendLog(line, kind) {
  const k = kind || confLogKind(line);
  confLogLines.push({ line, kind: k, ts: fmtLogTime() });
  if (confLogLines.length > 800) confLogLines = confLogLines.slice(-800);
  confRenderLog();
}

function confRenderLog() {
  const box = $("#confLogBox");
  if (!box) return;
  box.innerHTML = confLogLines
    .map(
      (x) =>
        `<div class="logBlock ${escapeHtml(x.kind)}"><span class="logLine">[${escapeHtml(x.ts)}] ${escapeHtml(x.line)}</span></div>`
    )
    .join("");
  box.scrollTop = box.scrollHeight;
}

function confRenderTimings(timings) {
  const panel = $("#confTimingPanel");
  if (!panel || !timings) {
    panel.innerHTML = `<div class="empty">提问后显示</div>`;
    return;
  }
  const chips = [
    ["总耗时", timings.total_ms],
    ["准备(索引+prompt)", timings.prepare_ms],
    ["匹配(LLM)", timings.match_ms],
    ["首 token", timings.match_first_token_ms],
    ["查表(取 answer)", timings.lookup_ms],
    ["输出 tokens", timings.match_output_tokens],
  ];
  panel.innerHTML = chips
    .map(([label, val]) => {
      const display =
        label === "输出 tokens" && typeof val === "number"
          ? String(val)
          : typeof val === "number"
            ? fmtMs(val)
            : escapeHtml(String(val));
      return `<div class="timingChip"><span>${escapeHtml(label)}</span><strong>${display}</strong></div>`;
    })
    .join("");
}

function fmtConfidence(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function renderConfCandidates(data) {
  const box = $("#confCandidatesBox");
  if (!box) return;
  const list = data?.candidates || confCandidates;
  if (!list?.length) {
    box.innerHTML = `<div class="confidenceEmpty">未匹配到候选（模型返回空列表）</div>`;
    return;
  }
  confCandidates = list;
  box.innerHTML = list
    .map((c, i) => {
      const pct = Math.round(Number(c.confidence || 0) * 1000) / 10;
      const width = Math.max(2, Math.min(100, pct));
      const active = c.id === confSelectedCandidateId ? " active" : "";
      return `<div class="confidenceCard fade-in${active}" data-candidate-id="${escapeHtml(c.id)}">
        <div class="confidenceCardHead">
          <span class="id">#${i + 1} ${escapeHtml(c.id)}</span>
          <span class="pct">${escapeHtml(fmtConfidence(c.confidence))}</span>
        </div>
        <div class="confidenceBar"><div class="confidenceBarFill" style="width:${width}%"></div></div>
        <div class="confidenceQuestion">${escapeHtml(c.question || "（无标准问题文本）")}</div>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".confidenceCard[data-candidate-id]").forEach((el) => {
    el.addEventListener("click", () => selectConfCandidate(el.dataset.candidateId));
  });
}

function setConfRawOutput(raw) {
  const el = $("#confRawOutput");
  if (!el) return;
  el.textContent = raw || "";
}

function setConfAnswerPreview(text, kbId, mode = "preview") {
  const preview = $("#confAnswersBox");
  const source = $("#confAnswerSource");
  if (!preview || !source) return;
  source.textContent = text || "";
  if (mode === "source") {
    preview.classList.add("hidden");
    source.classList.remove("hidden");
  } else {
    source.classList.add("hidden");
    preview.classList.remove("hidden");
    preview.innerHTML = text
      ? `<div class="fade-in">${renderMarkdownPreview(text, kbId)}</div>`
      : `<div class="empty">尚无回答。</div>`;
  }
}

async function loadConfQuestions(kbId) {
  if (!kbId) return [];
  const doc = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/questions`);
  confQuestionsCache = doc.items || [];
  return confQuestionsCache;
}

function getConfKbId() {
  return ($("#confKbSelect")?.value || "").trim();
}

function getConfTopK() {
  const n = parseInt($("#confTopK")?.value || "5", 10);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(20, n));
}

function updateConfAnswerLabel() {
  const el = $("#confAnswerLabel");
  if (!el) return;
  if (!confSelectedCandidateId || !confCandidates.length) {
    el.textContent = "回答";
    return;
  }
  const idx = confCandidates.findIndex((c) => c.id === confSelectedCandidateId);
  const c = confCandidates[idx];
  if (idx < 0 || !c) {
    el.textContent = "回答";
    return;
  }
  el.textContent = `#${idx + 1} ${c.id} · ${fmtConfidence(c.confidence)}`;
}

function switchConfLeftTab(tab) {
  const btn = $(`[data-conf-left-tab="${tab}"]`);
  if (!btn) return;
  $$("[data-conf-left-tab]").forEach((b) => b.classList.toggle("active", b === btn));
  $$("#confLeftTabAnswer,#confLeftTabCandidates").forEach((p) => p.classList.remove("active"));
  $(`#confLeftTab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`)?.classList.add("active");
}

async function selectConfCandidate(itemId) {
  const kbId = getConfKbId();
  confSelectedCandidateId = itemId;
  renderConfCandidates({ candidates: confCandidates });
  updateConfAnswerLabel();
  let item = confQuestionsCache.find((x) => x.id === itemId);
  if (!item && kbId) {
    await loadConfQuestions(kbId);
    item = confQuestionsCache.find((x) => x.id === itemId);
  }
  const mode = $("#confAnswerSource")?.classList.contains("hidden") ? "preview" : "source";
  if (item?.answer) {
    setConfAnswerPreview(item.answer, kbId, mode);
  } else {
    setConfAnswerPreview("未找到该条目的回答内容。", kbId);
  }
  switchConfLeftTab("answer");
}

async function askConfidenceStream() {
  const question = ($("#confQuestion")?.value || "").trim();
  const kbId = getConfKbId();
  const topK = getConfTopK();
  if (!question) return showToast("请输入问题", "error");
  if (!kbId) return showToast("请选择知识库", "error");

  $("#confAskBtn").disabled = true;
  confLogLines = [];
  confCandidates = [];
  confSelectedCandidateId = "";
  confAppendLog(`POST /ask/confidence/stream kb_id=${kbId} top_k=${topK}`);
  confAppendLog(`question: ${question}`);
  setConfAnswerPreview("", kbId);
  updateConfAnswerLabel();
  renderConfCandidates({ candidates: [] });
  $("#confCandidatesBox").innerHTML = `<div class="empty">匹配中…</div>`;
  setConfRawOutput("");
  confRenderTimings(null);

  try {
    const resp = await fetch("/ask/confidence/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, kb_id: kbId, top_k: topK }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const block of parts) {
        const evt = parseSseBlock(block);
        if (!evt) continue;
        if (evt.event === "log") confAppendLog(evt.data.line || "", evt.data.kind);
        if (evt.event === "candidates") {
          setConfRawOutput(evt.data.raw_output || "");
          renderConfCandidates(evt.data);
        }
        if (evt.event === "done") {
          const d = evt.data;
          const match = d.match || {};
          setConfRawOutput(match.raw_output || "");
          renderConfCandidates({ candidates: match.candidates || [] });
          confRenderTimings(d.timings);
          if (match.candidates?.length) {
            confSelectedCandidateId = match.candidates[0].id;
            renderConfCandidates({ candidates: match.candidates });
            updateConfAnswerLabel();
          }
          setConfAnswerPreview(d.answer || "", kbId);
        }
        if (evt.event === "error") confAppendLog(`ERROR: ${evt.data.detail}`, "error");
      }
    }
  } catch (e) {
    confAppendLog(String(e.message || e), "error");
    showToast(e.message || String(e), "error", 3200);
  } finally {
    $("#confAskBtn").disabled = false;
  }
}

function bindConfTabs() {
  $$("[data-conf-left-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchConfLeftTab(btn.dataset.confLeftTab));
  });
  $$("[data-conf-right-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("[data-conf-right-tab]").forEach((b) => b.classList.toggle("active", b === btn));
      $$("#confRightTabLog,#confRightTabRaw").forEach((p) => p.classList.remove("active"));
      const pane = $(`#confRightTab${btn.dataset.confRightTab.charAt(0).toUpperCase()}${btn.dataset.confRightTab.slice(1)}`);
      pane?.classList.add("active");
    });
  });
}

async function confidenceViewEnter() {
  await populateKbSelect($("#confKbSelect"));
  const kbId = getConfKbId();
  if (kbId) await loadConfQuestions(kbId);
}

document.addEventListener("DOMContentLoaded", () => {
  bindConfTabs();
  $("#confAskBtn")?.addEventListener("click", askConfidenceStream);
  $("#confClearBtn")?.addEventListener("click", () => {
    $("#confQuestion").value = "";
  });
  $("#confClearLogBtn")?.addEventListener("click", () => {
    confLogLines = [];
    confRenderLog();
    showToast("日志已清空");
  });
  $("#confKbSelect")?.addEventListener("change", async () => {
    await loadConfQuestions(getConfKbId());
  });
  $("#confRandomBtn")?.addEventListener("click", async () => {
    const kbId = getConfKbId();
    await loadConfQuestions(kbId);
    const enabled = confQuestionsCache.filter((x) => x.enabled !== false);
    if (!enabled.length) return showToast("当前知识库无可用问题", "error");
    const pick = enabled[Math.floor(Math.random() * enabled.length)];
    const variants = pick.variants || [];
    const q = variants.length ? variants[Math.floor(Math.random() * variants.length)] : pick.question;
    $("#confQuestion").value = q;
  });
  $("#confAnswerPreviewBtn")?.addEventListener("click", () => {
    const kbId = getConfKbId();
    setConfAnswerPreview($("#confAnswerSource").textContent, kbId, "preview");
    $("#confAnswerPreviewBtn").classList.add("primary");
    $("#confAnswerSourceBtn").classList.remove("primary");
  });
  $("#confAnswerSourceBtn")?.addEventListener("click", () => {
    setConfAnswerPreview($("#confAnswerSource").textContent, getConfKbId(), "source");
    $("#confAnswerSourceBtn").classList.add("primary");
    $("#confAnswerPreviewBtn").classList.remove("primary");
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter" && !$("#viewConfidence").classList.contains("hidden")) {
      askConfidenceStream();
    }
  });
});
