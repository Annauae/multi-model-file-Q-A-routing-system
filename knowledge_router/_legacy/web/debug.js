let debugQuestionsCache = [];
let debugCandidates = [];
let debugLastAnswers = [];

function getDebugKbId() {
  return ($("#debugKbSelect")?.value || "").trim();
}

function getDebugTopK() {
  const n = parseInt($("#debugTopK")?.value || "5", 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 5;
}

function renderDebugCandidates(candidates) {
  const box = $("#debugCandidatesBox");
  if (!box) return;
  if (!candidates?.length) {
    box.innerHTML = `<div class="empty">未匹配到候选</div>`;
    return;
  }
  debugCandidates = candidates;
  box.innerHTML = candidates
    .map((c, i) => {
      const pct = Math.round(Number(c.confidence || 0) * 1000) / 10;
      const width = Math.max(2, Math.min(100, pct));
      return `<div class="confidenceCard" data-answer-idx="${i}">
        <div class="confidenceCardHead"><span class="id">#${i + 1} ${escapeHtml(c.id)}</span><span>${escapeHtml(fmtConfidence(c.confidence))}</span></div>
        <div class="confidenceBar"><div class="confidenceBarFill" style="width:${width}%"></div></div>
        <div class="confidenceQuestion">${escapeHtml(c.question || "")}</div>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".confidenceCard[data-answer-idx]").forEach((el) => {
    el.addEventListener("click", () => {
      const card = $(`#debugAnswerCard-${el.dataset.answerIdx}`);
      card?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderAllAnswers(answers, kbId) {
  const box = $("#debugAnswersBox");
  if (!box) return;
  debugLastAnswers = answers || [];
  if (!answers?.length) {
    box.innerHTML = `<div class="empty">尚无回答。</div>`;
    return;
  }
  box.innerHTML = answers
    .map(
      (a, i) => `<article class="answerCard fade-in" id="debugAnswerCard-${i}">
        <div class="answerCardHead">
          <span><span class="id">#${i + 1} ${escapeHtml(a.id)}</span> · ${escapeHtml(fmtConfidence(a.confidence))}</span>
          <span class="muted">${escapeHtml(a.question || "")}</span>
        </div>
        <div class="answerCardBody mdPreview">${renderMarkdownPreview(a.answer || "（无回答内容）", kbId)}</div>
      </article>`
    )
    .join("");
}

async function loadDebugQuestions(kbId) {
  if (!kbId) return [];
  const doc = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/questions`);
  debugQuestionsCache = doc.items || [];
  return debugQuestionsCache;
}

async function askConfidenceStream() {
  const question = ($("#debugQuestion")?.value || "").trim();
  const kbId = getDebugKbId();
  const topK = getDebugTopK();
  if (!question) return showToast("请输入问题", "error");
  if (!kbId) return showToast("请选择知识库", "error");

  const btn = $("#debugAskBtn");
  await withButtonRunning(btn, "运行中…", async () => {
    renderAllAnswers([], kbId);
    renderDebugCandidates([]);
    renderTimingsPanel($("#askTimingPanel"), null);
    renderTokenPanel($("#askTokenPanel"), null);
    $("#debugAnswersBox").innerHTML = `<div class="empty">匹配中…</div>`;

    try {
      await streamAskConfidence(
        {
          question,
          kb_id: kbId,
          top_k: topK,
          match_profile_id: selectedMatchProfileId($("#debugMatchProfileSelect")),
        },
        (evt) => {
          if (evt.event === "candidates") renderDebugCandidates(evt.data.candidates || []);
          if (evt.event === "done") {
            const d = evt.data;
            const answers = d.answers || [];
            renderAllAnswers(answers, kbId);
            renderDebugCandidates(d.match?.candidates || []);
            renderTimingsPanel($("#askTimingPanel"), d.timings);
            renderTokenPanel($("#askTokenPanel"), d.timings);
          }
          if (evt.event === "error" && !evt.data?.timed_out) {
            showToast(evt.data.detail || "错误", "error", 3200);
          }
        }
      );
    } catch (e) {
      if (isAskTimeoutError(e)) {
        resetDebugAskIdle();
        renderAskTimeoutMetrics();
        showToast(`请求超时（${DEBUG_ASK_TIMEOUT_S}s）`, "error", 3200);
        return;
      }
      showToast(e.message || String(e), "error", 3200);
      $("#debugAnswersBox").innerHTML = `<div class="empty">请求失败</div>`;
    }
  });
}

async function debugViewEnter() {
  await populateKbSelect($("#debugKbSelect"));
  await refreshMatchProfileSelects();
  const kbId = getDebugKbId();
  if (kbId) await loadDebugQuestions(kbId);
}

document.addEventListener("DOMContentLoaded", () => {
  $("#debugAskBtn")?.addEventListener("click", askConfidenceStream);
  $("#debugClearBtn")?.addEventListener("click", () => {
    $("#debugQuestion").value = "";
    resetDebugAskIdle();
  });
  $("#debugKbSelect")?.addEventListener("change", () => loadDebugQuestions(getDebugKbId()));
  $("#debugRandomBtn")?.addEventListener("click", async () => {
    const kbId = getDebugKbId();
    await loadDebugQuestions(kbId);
    const enabled = debugQuestionsCache.filter((x) => x.enabled !== false);
    if (!enabled.length) return showToast("当前知识库无可用问题", "error");
    const pick = enabled[Math.floor(Math.random() * enabled.length)];
    const variants = pick.variants || [];
    const q = variants.length ? variants[Math.floor(Math.random() * variants.length)] : pick.question;
    $("#debugQuestion").value = q;
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter" && currentModule === "debug" && currentSub === "single") {
      askConfidenceStream();
    }
  });
});

// 供 recallTest 复用
window.renderRecallAnswerModal = function (answers, kbId, question) {
  showModal(
    "置信度回答",
    `<p class="muted">${escapeHtml(question)}</p><div id="recallModalAnswers"></div>`,
    async () => {},
    true
  );
  const box = $("#recallModalAnswers");
  if (box) {
    box.innerHTML = (answers || [])
      .map(
        (a, i) => `<article class="answerCard" style="margin-top:10px">
          <div class="answerCardHead"><span class="id">#${i + 1} ${escapeHtml(a.id)}</span> · ${escapeHtml(fmtConfidence(a.confidence))}</div>
          <div class="answerCardBody mdPreview">${renderMarkdownPreview(a.answer || "", kbId)}</div>
        </article>`
      )
      .join("") || `<div class="empty">无候选回答</div>`;
  }
};
