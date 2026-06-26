/** 问题生成共用：Markdown 选段、行号预览、指标面板 */
let importExtractedMarkdown = "";
let importExtractedLineCount = 0;
let importExtractedPath = "";
let importSelections = [];
let importActiveSelectionId = "";
let importSelectionSeq = 0;
let importMdViewMode = "source";
let importLastMetrics = null;

function importKbIdForPreview() {
  return "documents";
}

function syncImportLineCount() {
  importExtractedLineCount = importExtractedMarkdown ? importExtractedMarkdown.split("\n").length : 0;
}

function sliceImportMarkdownLines(lineStart, lineEnd) {
  const lines = importExtractedMarkdown.split("\n");
  const s = Math.max(1, lineStart);
  const e = Math.min(lines.length, Math.max(s, lineEnd));
  return lines.slice(s - 1, e).join("\n");
}

function resyncImportSelectionAnswers() {
  importSelections.forEach((sel) => {
    sel.answer = sliceImportMarkdownLines(sel.lineStart, sel.lineEnd);
  });
}

function importLineHighlightClass(lineNo) {
  const active = importSelections.find((s) => s.id === importActiveSelectionId);
  const inAny = importSelections.some((s) => lineNo >= s.lineStart && lineNo <= s.lineEnd);
  if (active && lineNo >= active.lineStart && lineNo <= active.lineEnd) return "mdLineActive";
  if (active && inAny) return "mdLineSelected";
  if (active) return "mdLineDimmed";
  if (inAny) return "mdLineSelected";
  return "";
}

function renderImportMdLineViewer(viewerEl) {
  if (!viewerEl || !importExtractedMarkdown) {
    if (viewerEl) viewerEl.innerHTML = "";
    return;
  }
  const lines = importExtractedMarkdown.split("\n");
  const kbId = importKbIdForPreview();
  viewerEl.innerHTML = lines
    .map((line, i) => {
      const lineNo = i + 1;
      const hl = importLineHighlightClass(lineNo);
      const content =
        importMdViewMode === "preview"
          ? `<div class="mdLineContent mdPreview">${renderMarkdownPreview(line, kbId)}</div>`
          : `<div class="mdLineContent"><code>${escapeHtml(line || " ")}</code></div>`;
      return `<div class="mdLineRow ${hl}" data-line="${lineNo}"><span class="mdLineNo">${lineNo}</span>${content}</div>`;
    })
    .join("");
}

function renderImportSelectionsList(listEl, { onGenerate, genBtnClass = "importSelGenBtn" } = {}) {
  if (!listEl) return;
  if (!importSelections.length) {
    listEl.innerHTML = `<div class="empty muted">添加行范围后在此编辑标准问题与其他问法</div>`;
    return;
  }
  listEl.innerHTML = importSelections
    .map((sel) => {
      const variants = (sel.variants || []).join("\n");
      const active = sel.id === importActiveSelectionId ? " active" : "";
      return `<div class="uploadSelectionCard${active}" data-sel-id="${escapeHtml(sel.id)}">
        <div class="uploadSelectionHead">
          <strong>第 ${sel.lineStart}–${sel.lineEnd} 行</strong>
          <span class="headActions">
            <button type="button" class="btn btnXs ghost importSelFocusBtn" data-sel-id="${escapeHtml(sel.id)}">高亮</button>
            <button type="button" class="btn btnXs primary ${genBtnClass}" data-sel-id="${escapeHtml(sel.id)}">自动生成问法</button>
            <button type="button" class="btn btnXs ghost importSelDelBtn" data-sel-id="${escapeHtml(sel.id)}">删除</button>
          </span>
        </div>
        <label class="fieldLabel">标准问题<input type="text" class="importSelQuestion" data-sel-id="${escapeHtml(sel.id)}" value="${escapeHtml(sel.question || "")}" /></label>
        <label class="fieldLabel">其他问法（每行一条）<textarea class="importSelVariants" rows="2" data-sel-id="${escapeHtml(sel.id)}">${escapeHtml(variants)}</textarea></label>
      </div>`;
    })
    .join("");

  const rerender = () => {
    renderImportMdLineViewer(window._importMdViewerEl);
    renderImportSelectionsList(listEl, { onGenerate, genBtnClass });
  };

  listEl.querySelectorAll(".importSelFocusBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      importActiveSelectionId = btn.dataset.selId || "";
      rerender();
    });
  });
  listEl.querySelectorAll(".importSelDelBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      importSelections = importSelections.filter((s) => s.id !== btn.dataset.selId);
      if (importActiveSelectionId === btn.dataset.selId) importActiveSelectionId = importSelections[0]?.id || "";
      rerender();
    });
  });
  listEl.querySelectorAll(`.${genBtnClass}`).forEach((btn) => {
    btn.addEventListener("click", () => {
      if (onGenerate) onGenerate(btn.dataset.selId, btn);
    });
  });
  listEl.querySelectorAll(".importSelQuestion").forEach((inp) => {
    inp.addEventListener("input", () => {
      const sel = importSelections.find((s) => s.id === inp.dataset.selId);
      if (sel) sel.question = inp.value;
    });
  });
  listEl.querySelectorAll(".importSelVariants").forEach((ta) => {
    ta.addEventListener("input", () => {
      const sel = importSelections.find((s) => s.id === ta.dataset.selId);
      if (sel) sel.variants = ta.value.split("\n").map((s) => s.trim()).filter(Boolean);
    });
  });
  listEl.querySelectorAll(".uploadSelectionCard").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button,input,textarea")) return;
      importActiveSelectionId = card.dataset.selId || "";
      rerender();
    });
  });
}

function initImportSelectLineInputs(startEl, endEl) {
  if (startEl) {
    startEl.value = "1";
    startEl.min = "1";
    startEl.max = String(Math.max(1, importExtractedLineCount));
  }
  if (endEl) {
    endEl.value = String(Math.max(1, importExtractedLineCount));
    endEl.min = "1";
    endEl.max = String(Math.max(1, importExtractedLineCount));
  }
}

function addImportSelection(startEl, endEl, viewerEl, listEl, onGenerate) {
  const start = Number(startEl?.value || 1);
  const end = Number(endEl?.value || 1);
  if (!importExtractedMarkdown) return showToast("请先选择 Markdown 文件", "error");
  const lineStart = Math.max(1, Math.min(start, end));
  const lineEnd = Math.min(importExtractedLineCount, Math.max(start, end));
  if (lineStart > importExtractedLineCount) return showToast("行范围无效", "error");
  const answer = sliceImportMarkdownLines(lineStart, lineEnd);
  if (!answer.trim()) return showToast("选中范围无内容", "error");
  importSelectionSeq += 1;
  const id = `sel_${importSelectionSeq}`;
  importSelections.push({ id, lineStart, lineEnd, question: "", variants: [], answer });
  importActiveSelectionId = id;
  window._importMdViewerEl = viewerEl;
  renderImportMdLineViewer(viewerEl);
  renderImportSelectionsList(listEl, { onGenerate });
}

function resetImportSelections() {
  importSelections = [];
  importActiveSelectionId = "";
  importSelectionSeq = 0;
}

function loadImportMarkdown(data) {
  importExtractedMarkdown = data.markdown || "";
  importExtractedPath = data.path || "";
  syncImportLineCount();
  resetImportSelections();
}

function renderImportMetrics(data) {
  importLastMetrics = data || null;
  updateModuleMetricsVisibility();
  switchRightTab("timing");
  renderTimingsPanel($("#importTimingPanel"), data?.timings, "运行后显示", "import");
  renderTokenPanel(
    $("#importTokenPanel"),
    { tokens: data?.tokens || {}, token_breakdown: data?.token_breakdown || [] },
    "运行后显示"
  );
}

function restoreImportMetrics() {
  if (importLastMetrics) renderImportMetrics(importLastMetrics);
  else clearImportMetrics();
}

function clearImportMetrics() {
  importLastMetrics = null;
  renderTimingsPanel($("#importTimingPanel"), null, "运行后显示", "import");
  renderTokenPanel($("#importTokenPanel"), null, "运行后显示");
}

function appendImportLog(progEl, line, kind = "log") {
  if (!progEl) return;
  progEl.classList.remove("hidden");
  const div = document.createElement("div");
  div.className = `importLogLine ${kind}`;
  div.textContent = line;
  progEl.appendChild(div);
  progEl.scrollTop = progEl.scrollHeight;
}

function clearImportLog(progEl) {
  if (progEl) progEl.innerHTML = "";
}

function renderFileTreeNode(node, depth = 0) {
  const pad = depth * 14;
  if (node.type === "folder") {
    const children = (node.children || []).map((c) => renderFileTreeNode(c, depth + 1)).join("");
    const kbAttr = node.kb_id ? ` data-kb-id="${escapeHtml(node.kb_id)}"` : "";
    return `<div class="fileTreeFolder" style="padding-left:${pad}px">
      <button type="button" class="fileTreeToggle" data-expanded="1"${kbAttr}>▾ ${escapeHtml(node.name)}/</button>
      <div class="fileTreeChildren">${children}</div>
    </div>`;
  }
  const kindLabel =
    node.kind === "source_pdf" ? "PDF" : node.kind === "source_md" ? "MD" : "MD";
  const kindClass = node.kind === "source_pdf" ? "fileKindPdf" : "fileKindMd";
  return `<button type="button" class="fileTreeFile${node.kind === "source_pdf" ? " fileTreePdf" : ""}" style="padding-left:${pad + 18}px" data-path="${escapeHtml(node.path)}" data-kind="${escapeHtml(node.kind)}" data-name="${escapeHtml(node.name)}">
    <span class="fileKindBadge ${kindClass}">${kindLabel}</span>
    <span class="fileTreeName">${escapeHtml(node.name)}</span>
    ${node.line_count ? `<span class="fileTreeMeta muted">${node.line_count} 行</span>` : ""}
  </button>`;
}

function renderFileTree(containerEl, tree) {
  if (!containerEl) return;
  if (!tree?.length) {
    containerEl.innerHTML = `<div class="empty muted">暂无文件</div>`;
    return;
  }
  containerEl.innerHTML = tree.map((n) => renderFileTreeNode(n)).join("");
  containerEl.querySelectorAll(".fileTreeToggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const expanded = btn.dataset.expanded === "1";
      btn.dataset.expanded = expanded ? "0" : "1";
      btn.textContent = `${expanded ? "▸" : "▾"} ${btn.textContent.replace(/^[▾▸]\s/, "").replace(/\/$/, "")}/`;
      const children = btn.parentElement?.querySelector(".fileTreeChildren");
      children?.classList.toggle("collapsed", expanded);
    });
  });
}

function filterTreeMarkdownOnly(nodes) {
  const out = [];
  for (const node of nodes || []) {
    if (node.type === "folder") {
      const children = filterTreeMarkdownOnly(node.children);
      if (children.length) out.push({ ...node, children });
    } else if (node.type === "file" && node.kind !== "source_pdf") {
      if (node.kind === "source_md" || node.kind === "module_md") out.push(node);
    }
  }
  return out;
}

function highlightFileTreeSelection(containerEl, path) {
  if (!containerEl) return;
  containerEl.querySelectorAll(".fileTreeFile").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.path === path);
  });
}
