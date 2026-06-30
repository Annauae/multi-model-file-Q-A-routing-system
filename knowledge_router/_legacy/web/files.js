let filesSelectedPath = "";
let filesSelectedKind = "";
let filesSelectedName = "";
let filesEditViewMode = "source";
let filesPdfRanges = [{ start: 1, end: 5 }];

function addFilesPdfRange(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  syncFilesPdfRangesFromDom();
  const last = filesPdfRanges[filesPdfRanges.length - 1] || { start: 1, end: 5 };
  const nextStart = Math.max(1, last.end + 1);
  const nextEnd = nextStart + 2;
  filesPdfRanges.push({ start: nextStart, end: nextEnd });
  renderFilesPdfRanges();
  showToast(`已添加范围 ${nextStart}–${nextEnd}`);
}

function removeFilesPdfRange(idx) {
  syncFilesPdfRangesFromDom();
  if (filesPdfRanges.length > 1 && Number.isFinite(idx)) {
    filesPdfRanges.splice(idx, 1);
    renderFilesPdfRanges();
  }
}

function syncFilesPdfRangesFromDom() {
  const rows = $$("#filesPdfRangeList .rangeRow");
  if (!rows.length) return;
  filesPdfRanges = rows.map((row) => ({
    start: Math.max(1, Number(row.querySelector(".filesPdfRangeStart")?.value || 1)),
    end: Math.max(1, Number(row.querySelector(".filesPdfRangeEnd")?.value || 1)),
  }));
}

function renderFilesPdfRanges() {
  const list = $("#filesPdfRangeList");
  if (!list) return;
  list.innerHTML = filesPdfRanges
    .map(
      (r, i) => `<div class="rangeRow" data-range-idx="${i}">
        <span class="uploadRangeTitle">从</span>
        <input type="number" class="pageRangeInput filesPdfRangeStart" value="${r.start}" min="1" />
        <span class="uploadRangeTitle">到</span>
        <input type="number" class="pageRangeInput filesPdfRangeEnd" value="${r.end}" min="1" />
        ${
          filesPdfRanges.length > 1
            ? `<button type="button" class="btn btnXs ghost filesPdfRangeRemove">删除</button>`
            : ""
        }
      </div>`
    )
    .join("");
  list.querySelectorAll(".filesPdfRangeStart, .filesPdfRangeEnd").forEach((inp) => {
    inp.addEventListener("change", syncFilesPdfRangesFromDom);
    inp.addEventListener("input", syncFilesPdfRangesFromDom);
  });
  list.querySelectorAll(".filesPdfRangeRemove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      syncFilesPdfRangesFromDom();
      const idx = Number(btn.closest(".rangeRow")?.dataset.rangeIdx);
      if (filesPdfRanges.length > 1 && Number.isFinite(idx)) {
        filesPdfRanges.splice(idx, 1);
        renderFilesPdfRanges();
      }
    });
  });
}

function updateFilesToolbar() {
  const label = $("#filesSelectedLabel");
  const title = $("#filesEditorTitle");
  const saveBtn = $("#filesMainSaveBtn");
  if (filesSelectedPath && filesSelectedName) {
    const kindText = filesSelectedKind === "source_pdf" ? "PDF" : "Markdown";
    const text = `${kindText}：${filesSelectedName}`;
    if (label) {
      label.textContent = text;
      label.classList.remove("muted");
    }
    if (title) title.textContent = filesSelectedKind === "source_pdf" ? "PDF 预览" : "Markdown 编辑";
  } else {
    if (label) {
      label.textContent = "未选择文件";
      label.classList.add("muted");
    }
    if (title) title.textContent = "Markdown 编辑";
  }
  if (saveBtn) saveBtn.disabled = !filesSelectedPath || filesSelectedKind === "source_pdf";
  const renameItem = $(`#filesMainActionsDropdown [data-files-action="rename"]`);
  renameItem?.classList.toggle("hidden", !filesSelectedPath);
  const deleteItem = $(`#filesMainActionsDropdown [data-files-action="delete"]`);
  deleteItem?.classList.toggle("hidden", !filesSelectedPath);
  updateFilesEditorState();
}

function updateFilesEditorState() {
  const isPdf = filesSelectedKind === "source_pdf";
  $("#filesPdfHint")?.classList.toggle("hidden", !isPdf);
  $("#filesEditSourcePane")?.classList.toggle("hidden", isPdf);
  $("#filesEditPreviewPane")?.classList.toggle("hidden", isPdf || filesEditViewMode !== "preview");
  $("#filesEditSegment")?.classList.toggle("hidden", isPdf);
  if (isPdf) {
    const ta = $("#filesEditSource");
    if (ta) ta.value = "";
  }
}

async function loadFilesTree() {
  const data = await apiJson("/markdown-files/tree");
  renderFileTree($("#filesTree"), data.tree || []);
  if (filesSelectedPath) highlightFileTreeSelection($("#filesTree"), filesSelectedPath);
}

function filesEditorHasUnsavedChanges() {
  const ta = $("#filesEditSource");
  if (!ta || !filesSelectedPath || filesSelectedKind === "source_pdf") return false;
  return (ta.value || "") !== (ta.dataset.loadedContent ?? "");
}

async function selectFilesTreeItem(btn) {
  const newPath = btn.dataset.path || "";
  if (newPath !== filesSelectedPath && filesEditorHasUnsavedChanges()) {
    if (!confirm("当前 Markdown 有未保存修改，切换文件将丢失。是否继续？")) return;
  }
  const prevKind = filesSelectedKind;
  filesSelectedPath = btn.dataset.path || "";
  filesSelectedKind = btn.dataset.kind || "";
  filesSelectedName = btn.dataset.name || "";
  if (filesSelectedKind === "source_pdf" && prevKind !== "source_pdf") {
    filesPdfRanges = [{ start: 1, end: 5 }];
    renderFilesPdfRanges();
  }
  highlightFileTreeSelection($("#filesTree"), filesSelectedPath);
  updateFilesToolbar();
  if (filesSelectedKind === "source_pdf") return;
  if (filesSelectedKind === "source_md" || filesSelectedKind === "module_md") {
    await loadFilesMarkdown(filesSelectedPath);
  }
}

async function loadFilesMarkdown(path) {
  const data = await apiJson(`/markdown-files/content?path=${encodeURIComponent(path)}`);
  const ta = $("#filesEditSource");
  if (ta) {
    ta.value = data.markdown || "";
    ta.dataset.loadedPath = path;
    ta.dataset.loadedContent = data.markdown || "";
  }
  const lineLabel = $("#filesEditLineCountLabel");
  if (lineLabel) lineLabel.textContent = data.line_count ? `共 ${data.line_count} 行` : "";
  setFilesEditTab("source");
}

function setFilesEditTab(mode) {
  filesEditViewMode = mode;
  const isPreview = mode === "preview";
  $("#filesEditTabSource")?.classList.toggle("active", !isPreview);
  $("#filesEditTabPreview")?.classList.toggle("active", isPreview);
  $("#filesEditSourcePane")?.classList.toggle("active", !isPreview);
  $("#filesEditPreviewPane")?.classList.toggle("active", isPreview);
  if (isPreview) refreshFilesEditPreview();
}

function refreshFilesEditPreview() {
  const pane = $("#filesEditPreviewPane");
  const md = $("#filesEditSource")?.value || "";
  if (pane) pane.innerHTML = renderMarkdownPreview(md, "documents");
}

function filesImportRange() {
  syncFilesPdfRangesFromDom();
  return filesPdfRanges.map((r) => {
    const start = Math.max(1, r.start);
    return [start, Math.max(start, r.end)];
  });
}

async function saveFilesMarkdown(btn) {
  if (!filesSelectedPath || filesSelectedKind === "source_pdf") return showToast("请选择可编辑的 Markdown", "error");
  const markdown = $("#filesEditSource")?.value || "";
  await withButtonRunning(btn, "保存中…", async () => {
    const data = await apiJson("/markdown-files/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filesSelectedPath, markdown }),
    });
    const ta = $("#filesEditSource");
    if (ta) {
      ta.dataset.loadedContent = markdown;
      ta.dataset.loadedPath = filesSelectedPath;
    }
    const lineLabel = $("#filesEditLineCountLabel");
    if (lineLabel) lineLabel.textContent = data.line_count ? `共 ${data.line_count} 行` : "";
    showToast("已保存");
  });
}

async function deleteFilesItem() {
  if (!filesSelectedPath) return showToast("请先选择文件", "error");
  const name = filesSelectedName;
  showModal(
    "删除文件",
    `<p>确定删除 <strong>${escapeHtml(name)}</strong>？此操作不可撤销。</p>`,
    async () => {
      await apiJson(`/markdown-files?path=${encodeURIComponent(filesSelectedPath)}`, { method: "DELETE" });
      filesSelectedPath = "";
      filesSelectedKind = "";
      filesSelectedName = "";
      $("#filesEditSource") && ($("#filesEditSource").value = "");
      updateFilesToolbar();
      await loadFilesTree();
      showToast("已删除");
    }
  );
}

async function renameFilesItem() {
  if (!filesSelectedPath) return showToast("请先选择文件", "error");
  showModal(
    "重命名",
    `<label class="fieldLabel">新文件名<input id="modalRenameFile" type="text" value="${escapeHtml(filesSelectedName)}" /></label>`,
    async () => {
      const name = ($("#modalRenameFile")?.value || "").trim();
      if (!name) throw new Error("文件名不能为空");
      const data = await apiJson("/markdown-files/rename", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filesSelectedPath, name }),
      });
      filesSelectedPath = data.path || filesSelectedPath;
      filesSelectedName = data.name || name;
      updateFilesToolbar();
      await loadFilesTree();
      highlightFileTreeSelection($("#filesTree"), filesSelectedPath);
      showToast("已重命名");
    }
  );
}

function promptNewMarkdownFile() {
  showModal(
    "新建 Markdown",
    `<label class="fieldLabel">文件名<input id="modalNewMdName" type="text" placeholder="document.md" /></label>`,
    async () => {
      const name = ($("#modalNewMdName")?.value || "").trim();
      if (!name) throw new Error("文件名不能为空");
      const data = await apiJson("/markdown-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, markdown: "" }),
      });
      await loadFilesTree();
      const btn = $(`#filesTree .fileTreeFile[data-path="${CSS.escape(data.path)}"]`);
      if (btn) await selectFilesTreeItem(btn);
      showToast("已创建");
    }
  );
}

async function extractFilesSource(btn) {
  if (!filesSelectedName || filesSelectedKind !== "source_pdf") {
    return showToast("请选择 PDF 文件", "error");
  }
  const ranges = filesImportRange();
  if (!ranges.length) return showToast("请指定有效页码范围", "error");
  const prog = $("#filesProgress");
  const metricsTarget = extractMetricsTarget();
  clearImportLog(prog);
  clearImportMetrics(metricsTarget);
  prog?.classList.remove("hidden");
  try {
    await withButtonRunning(btn, "提取中…", async () => {
      appendImportLog(prog, "开始提取…", "step");
      appendImportLog(prog, "正在连接服务器…", "step");
      const resp = await fetch("/documents/extract/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: filesSelectedName, ranges }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      await consumeSseStream(resp, async (evt) => {
        if (evt.event === "log") {
          const kind = evt.data.kind || (String(evt.data.line || "").startsWith("[step]") ? "step" : "log");
          appendImportLog(prog, evt.data.line, kind);
        }
        if (evt.event === "done") {
          renderImportMetrics(evt.data, metricsTarget);
          showToast("提取完成");
          await loadFilesTree();
          const openPath = evt.data.module_path || (evt.data.module_paths || []).slice(-1)[0] || "";
          if (openPath) {
            filesSelectedPath = openPath;
            filesSelectedKind = "module_md";
            filesSelectedName = openPath.split("/").pop() || "";
            updateFilesToolbar();
            highlightFileTreeSelection($("#filesTree"), filesSelectedPath);
            await loadFilesMarkdown(openPath);
          }
        }
        if (evt.event === "error") throw new Error(evt.data.detail);
      });
    });
  } catch (e) {
    appendImportLog(prog, e.message || String(e), "error");
    showToast(e.message || String(e), "error", 3200);
  }
}

function openExtractModal() {
  if (filesSelectedKind !== "source_pdf" || !filesSelectedName) {
    return showToast("请先在文件树中选择 PDF 文件", "error");
  }
  const label = $("#extractModalFileLabel");
  if (label) label.textContent = `PDF：${filesSelectedName}`;
  renderFilesPdfRanges();
  clearImportLog($("#filesProgress"));
  clearImportMetrics(extractMetricsTarget());
  $("#extractModalOverlay")?.classList.remove("hidden");
}

function closeExtractModal() {
  $("#extractModalOverlay")?.classList.add("hidden");
}

function openUploadDialog() {
  $("#filesFileInput")?.click();
}

async function filesViewEnter() {
  bindFilesPanel();
  await loadFilesTree();
  updateFilesToolbar();
}

function bindFilesPanel() {
  const root = document.body;
  if (root.dataset.filesBound === "1") return;
  root.dataset.filesBound = "1";

  $("#extractModalOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "extractModalOverlay") closeExtractModal();
  });
  $("#extractModalCloseBtn")?.addEventListener("click", closeExtractModal);
  $("#extractModalOverlay")?.addEventListener("click", (e) => {
    if (e.target.closest("#filesAddPdfRangeBtn")) {
      e.preventDefault();
      e.stopPropagation();
      addFilesPdfRange(e);
    }
    const removeBtn = e.target.closest(".filesPdfRangeRemove");
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(removeBtn.closest(".rangeRow")?.dataset.rangeIdx);
      removeFilesPdfRange(idx);
    }
  });

  $("#filesTree")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".fileTreeFile");
    if (btn) selectFilesTreeItem(btn);
  });

  $("#filesToolbarUpload")?.addEventListener("click", openUploadDialog);
  $("#filesToolbarExtract")?.addEventListener("click", openExtractModal);
  $("#filesToolbarGenerate")?.addEventListener("click", () => {
    if (typeof openGenerateModal === "function") openGenerateModal();
  });
  $("#filesToolbarRefresh")?.addEventListener("click", () => loadFilesTree().then(() => showToast("已刷新")));
  $("#filesMainSaveBtn")?.addEventListener("click", () => saveFilesMarkdown($("#filesMainSaveBtn")));
  $$("#filesMainActionsDropdown [data-files-action]").forEach((item) => {
    item.addEventListener("click", () => {
      closeAllDropdowns();
      const action = item.dataset.filesAction;
      if (action === "newMd") promptNewMarkdownFile();
      else if (action === "rename") renameFilesItem();
      else if (action === "delete") deleteFilesItem();
    });
  });

  $("#filesFileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.endsWith(".md")) {
      showToast("仅支持 PDF 或 Markdown", "error");
      e.target.value = "";
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    try {
      await fetch("/documents/upload", { method: "POST", body: fd }).then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      });
      await loadFilesTree();
      showToast("上传成功");
    } catch (err) {
      showToast(err.message || String(err), "error", 3200);
    }
    e.target.value = "";
  });

  $("#filesExtractBtn")?.addEventListener("click", () => extractFilesSource($("#filesExtractBtn")));
  $("#filesEditTabSource")?.addEventListener("click", () => setFilesEditTab("source"));
  $("#filesEditTabPreview")?.addEventListener("click", () => setFilesEditTab("preview"));
  $("#filesEditSource")?.addEventListener("input", () => refreshFilesEditPreview());
}

window.addFilesPdfRange = addFilesPdfRange;
window.getFilesSelection = () => ({
  path: filesSelectedPath,
  kind: filesSelectedKind,
  name: filesSelectedName,
});

document.addEventListener("DOMContentLoaded", () => {
  bindFilesPanel();
});
