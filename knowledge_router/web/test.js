let logLines = [];
let questionsCache = [];

function logKindFromLine(line) {
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

function appendLog(line, kind) {
  const k = kind || logKindFromLine(line);
  logLines.push({ line, kind: k, ts: fmtLogTime() });
  if (logLines.length > 800) logLines = logLines.slice(-800);
  renderLog();
}

function renderLog() {
  const box = $("#logBox");
  if (!box) return;
  box.innerHTML = logLines
    .map(
      (x) =>
        `<div class="logBlock ${escapeHtml(x.kind)}"><span class="logLine">[${escapeHtml(x.ts)}] ${escapeHtml(x.line)}</span></div>`
    )
    .join("");
  box.scrollTop = box.scrollHeight;
}

function renderTimings(timings) {
  const panel = $("#timingPanel");
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
        label === "输出 tokens" && typeof val === "number" ? String(val) : typeof val === "number" ? fmtMs(val) : escapeHtml(String(val));
      return `<div class="timingChip"><span>${escapeHtml(label)}</span><strong>${display}</strong></div>`;
    })
    .join("");
}

function renderMatch(match) {
  const box = $("#matchBox");
  if (!box) return;
  if (!match) {
    box.innerHTML = `<div class="empty">等待提问…</div>`;
    return;
  }
  if (match.need_clarification) {
    box.innerHTML = `<div class="matchCard"><div><strong>未匹配</strong></div><div class="raw">${escapeHtml(match.raw_output || "NONE")}</div><p>${escapeHtml(match.clarification_question || "")}</p></div>`;
    return;
  }
  box.innerHTML = `<div class="matchCard fade-in">
    <div>模型输出：<span class="raw">${escapeHtml(match.raw_output || "")}</span></div>
    <div>matched_id：<strong>${escapeHtml(match.matched_id || "")}</strong></div>
    <div>标准问题：${escapeHtml(match.matched_question || "")}</div>
  </div>`;
}

function setAnswerPreview(text, kbId, mode = "preview") {
  const preview = $("#answersBox");
  const source = $("#streamAnswerSource");
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

async function loadQuestionsForKb(kbId) {
  if (!kbId) return [];
  const doc = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/questions`);
  questionsCache = doc.items || [];
  return questionsCache;
}

async function loadJsonTab(kbId) {
  const doc = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/questions`);
  const pretty = JSON.stringify(doc, null, 2);
  $("#filePreviewBox").textContent = pretty;
  $("#fileSourceBox").textContent = pretty;
}

async function askStream() {
  const question = ($("#question")?.value || "").trim();
  const kbId = getSelectedKbId();
  if (!question) return alert("请输入问题");
  if (!kbId) return alert("请选择知识库");

  $("#askBtn").disabled = true;
  logLines = [];
  appendLog(`POST /ask/stream kb_id=${kbId}`);
  appendLog(`question: ${question}`);
  setAnswerPreview("", kbId);
  renderMatch(null);
  renderTimings(null);

  try {
    const resp = await fetch("/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, kb_id: kbId }),
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
        if (evt.event === "log") appendLog(evt.data.line || "", evt.data.kind);
        if (evt.event === "match") renderMatch(evt.data);
        if (evt.event === "done") {
          const d = evt.data;
          renderMatch(d.match);
          renderTimings(d.timings);
          if (d.match?.need_clarification) {
            setAnswerPreview(d.match.clarification_question || "未能匹配。", kbId);
          } else {
            setAnswerPreview(d.answer || "", kbId);
          }
        }
        if (evt.event === "error") appendLog(`ERROR: ${evt.data.detail}`, "error");
      }
    }
  } catch (e) {
    appendLog(String(e.message || e), "error");
    alert(e.message || e);
  } finally {
    $("#askBtn").disabled = false;
  }
}

function bindTestTabs() {
  $$("[data-left-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("[data-left-tab]").forEach((b) => b.classList.toggle("active", b === btn));
      $$("#leftTabAnswer,#leftTabMatch").forEach((p) => p.classList.remove("active"));
      $(`#leftTab${btn.dataset.leftTab.charAt(0).toUpperCase()}${btn.dataset.leftTab.slice(1)}`)?.classList.add("active");
    });
  });
  $$("[data-right-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("[data-right-tab]").forEach((b) => b.classList.toggle("active", b === btn));
      $$("#rightTabLog,#rightTabFiles").forEach((p) => p.classList.remove("active"));
      $(`#rightTab${btn.dataset.rightTab.charAt(0).toUpperCase()}${btn.dataset.rightTab.slice(1)}`)?.classList.add("active");
    });
  });
}

async function testViewEnter() {
  await populateKbSelect();
  const kbId = getSelectedKbId();
  if (kbId) await loadJsonTab(kbId);
}

document.addEventListener("DOMContentLoaded", () => {
  bindTestTabs();
  $("#askBtn")?.addEventListener("click", askStream);
  $("#clearBtn")?.addEventListener("click", () => {
    $("#question").value = "";
  });
  $("#clearLogBtn")?.addEventListener("click", () => {
    logLines = [];
    renderLog();
    showToast("日志已清空");
  });
  $("#kbSelect")?.addEventListener("change", async () => {
    const kbId = getSelectedKbId();
    await loadQuestionsForKb(kbId);
    await loadJsonTab(kbId);
  });
  $("#randomQuestionBtn")?.addEventListener("click", async () => {
    const kbId = getSelectedKbId();
    await loadQuestionsForKb(kbId);
    const enabled = questionsCache.filter((x) => x.enabled !== false);
    if (!enabled.length) return alert("当前知识库无可用问题");
    const pick = enabled[Math.floor(Math.random() * enabled.length)];
    const variants = pick.variants || [];
    const q = variants.length ? variants[Math.floor(Math.random() * variants.length)] : pick.question;
    $("#question").value = q;
  });
  $("#answerPreviewBtn")?.addEventListener("click", () => {
    const kbId = getSelectedKbId();
    setAnswerPreview($("#streamAnswerSource").textContent, kbId, "preview");
    $("#answerPreviewBtn").classList.add("primary");
    $("#answerSourceBtn").classList.remove("primary");
  });
  $("#answerSourceBtn")?.addEventListener("click", () => {
    setAnswerPreview($("#streamAnswerSource").textContent, getSelectedKbId(), "source");
    $("#answerSourceBtn").classList.add("primary");
    $("#answerPreviewBtn").classList.remove("primary");
  });
  $("#filePreviewBtn")?.addEventListener("click", () => {
    $("#filePreviewBox").classList.remove("hidden");
    $("#fileSourceBox").classList.add("hidden");
  });
  $("#fileSourceBtn")?.addEventListener("click", () => {
    $("#fileSourceBox").classList.remove("hidden");
    $("#filePreviewBox").classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter" && !$("#viewTest").classList.contains("hidden")) askStream();
  });
});
