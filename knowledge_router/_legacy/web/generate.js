let generateTreeData = [];

function generateTargetKbId() {
  return ($("#generateKbSelect")?.value || "").trim();
}

function generateRouteKbId() {
  return generateTargetKbId();
}

async function loadGenerateTree() {
  const data = await apiJson("/markdown-files/tree");
  generateTreeData = filterTreeMarkdownOnly(data.tree || []);
  renderFileTree($("#generateFileTree"), generateTreeData);
}

async function loadGenerateMarkdown(path) {
  if (!path) return;
  highlightFileTreeSelection($("#generateFileTree"), path);
  const data = await apiJson(`/markdown-files/content?path=${encodeURIComponent(path)}`);
  loadImportMarkdown(data);
  const label = $("#generateFileLabel");
  if (label) {
    label.textContent = path;
    label.classList.remove("muted");
  }
  const lineLabel = $("#generateLineCountLabel");
  if (lineLabel) lineLabel.textContent = importExtractedLineCount ? `共 ${importExtractedLineCount} 行` : "";
  initImportSelectLineInputs($("#generateSelLineStart"), $("#generateSelLineEnd"));
  window._importMdViewerEl = $("#generateMdViewer");
  renderImportMdLineViewer($("#generateMdViewer"));
  renderImportSelectionsList($("#generateSelectionsList"), { onGenerate: generateQuestionsForSelection, genBtnClass: "genSelGenBtn" });
}

async function generateQuestionsForSelection(selId, btn) {
  const sel = importSelections.find((s) => s.id === selId);
  if (!sel) return;
  const kbId = generateRouteKbId();
  if (!kbId) return showToast("请选择导入知识库", "error");
  sel.answer = sliceImportMarkdownLines(sel.lineStart, sel.lineEnd);
  const metricsTarget = generateMetricsTarget();
  await withButtonRunning(btn, "运行中…", async () => {
    const t0 = performance.now();
    const data = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/import/generate-questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer_md: sel.answer }),
    });
    const matchMs = performance.now() - t0;
    sel.question = data.question || "";
    sel.variants = data.variants || [];
    renderImportSelectionsList($("#generateSelectionsList"), { onGenerate: generateQuestionsForSelection, genBtnClass: "genSelGenBtn" });
    const prev = importLastMetrics || {};
    renderImportMetrics(
      {
        ...prev,
        timings: {
          ...(prev.timings || {}),
          match_ms: matchMs,
          total_ms: (Number(prev.timings?.total_ms) || 0) + matchMs,
        },
        tokens: sumTokenUsage(prev.tokens, data.tokens),
        token_breakdown: [...(prev.token_breakdown || []), { phase: "FAQ 问法生成", usage: data.tokens || {} }],
      },
      metricsTarget
    );
    showToast("问法已生成");
  });
}

async function commitGenerateSelections(btn) {
  const kbId = generateTargetKbId();
  if (!kbId) return showToast("请选择导入知识库", "error");
  if (!importSelections.length) return showToast("请至少添加一个选择", "error");
  resyncImportSelectionAnswers();
  const items = importSelections.map((sel) => ({
    question: (sel.question || "").trim(),
    variants: sel.variants || [],
    answer: sel.answer,
  }));
  const invalid = items.find((it) => !it.question || !it.answer);
  if (invalid) return showToast("每条选择需填写标准问题", "error");
  await withButtonRunning(btn, "运行中…", async () => {
    const data = await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/import/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, append: true }),
    });
    showToast(`导入完成：${data.added ?? 0} 条`);
    if (typeof selectedKbId !== "undefined" && selectedKbId === kbId && typeof loadItems === "function") {
      await loadItems();
    }
  });
}

async function prepareGenerateModal() {
  await populateKbSelect($("#generateKbSelect"), { emptyLabel: "选择知识库…" });
  await loadGenerateTree();
  const sel = typeof getFilesSelection === "function" ? getFilesSelection() : {};
  if (sel.path && (sel.kind === "source_md" || sel.kind === "module_md")) {
    await loadGenerateMarkdown(sel.path);
  } else if (importExtractedPath && importExtractedMarkdown) {
    highlightFileTreeSelection($("#generateFileTree"), importExtractedPath);
    const label = $("#generateFileLabel");
    if (label) {
      label.textContent = importExtractedPath;
      label.classList.remove("muted");
    }
    initImportSelectLineInputs($("#generateSelLineStart"), $("#generateSelLineEnd"));
    window._importMdViewerEl = $("#generateMdViewer");
    renderImportMdLineViewer($("#generateMdViewer"));
    renderImportSelectionsList($("#generateSelectionsList"), {
      onGenerate: generateQuestionsForSelection,
      genBtnClass: "genSelGenBtn",
    });
  } else {
    resetImportSelections();
    importExtractedMarkdown = "";
    importExtractedPath = "";
    const viewer = $("#generateMdViewer");
    if (viewer) viewer.innerHTML = "";
    const label = $("#generateFileLabel");
    if (label) {
      label.textContent = "未选择 Markdown";
      label.classList.add("muted");
    }
  }
}

function openGenerateModal() {
  const sel = typeof getFilesSelection === "function" ? getFilesSelection() : {};
  if (sel.kind === "source_pdf") {
    return showToast("问题生成仅支持 Markdown 文件", "error");
  }
  prepareGenerateModal().then(() => {
    clearImportMetrics(generateMetricsTarget());
    $("#generateModalOverlay")?.classList.remove("hidden");
  });
}

function closeGenerateModal() {
  $("#generateModalOverlay")?.classList.add("hidden");
}

function bindGenerateModal() {
  if ($("#generateModalOverlay")?.dataset.bound === "1") return;
  $("#generateModalOverlay").dataset.bound = "1";

  $("#generateModalOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "generateModalOverlay") closeGenerateModal();
  });
  $("#generateModalCloseBtn")?.addEventListener("click", closeGenerateModal);

  $("#generateFileTree")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".fileTreeFile");
    if (!btn || btn.dataset.kind === "source_pdf") return;
    loadGenerateMarkdown(btn.dataset.path);
  });
  $("#generateCreateKbBtn")?.addEventListener("click", () => {
    promptCreateKb(async (kbId) => {
      await populateKbSelect($("#generateKbSelect"), { emptyLabel: "选择知识库…" });
      const sel = $("#generateKbSelect");
      if (sel) sel.value = kbId;
    });
  });
  $("#generateRefreshTreeBtn")?.addEventListener("click", () => loadGenerateTree().then(() => showToast("已刷新")));
  $("#generateAddSelectionBtn")?.addEventListener("click", () => {
    addImportSelection(
      $("#generateSelLineStart"),
      $("#generateSelLineEnd"),
      $("#generateMdViewer"),
      $("#generateSelectionsList"),
      generateQuestionsForSelection
    );
  });
  $("#generateCommitBtn")?.addEventListener("click", () => commitGenerateSelections($("#generateCommitBtn")));
  $("#generateMdTabSource")?.addEventListener("click", () => {
    importMdViewMode = "source";
    $("#generateMdTabSource")?.classList.add("active");
    $("#generateMdTabPreview")?.classList.remove("active");
    renderImportMdLineViewer($("#generateMdViewer"));
  });
  $("#generateMdTabPreview")?.addEventListener("click", () => {
    importMdViewMode = "preview";
    $("#generateMdTabPreview")?.classList.add("active");
    $("#generateMdTabSource")?.classList.remove("active");
    renderImportMdLineViewer($("#generateMdViewer"));
  });
}

window.openGenerateModal = openGenerateModal;

document.addEventListener("DOMContentLoaded", () => {
  bindGenerateModal();
});
