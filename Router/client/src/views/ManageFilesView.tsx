/**
 * ManageFilesView.tsx — 管理 · 文件管理
 *
 * 典型工作流（上传 → 转 MD → 生成问题 → 导入双库）：
 *   上传 POST /documents/upload
 *   → ExtractModal 转 MD POST /documents/extract/stream
 *   → GenerateModal 生成问法 POST .../import/generate-questions
 *   → 导入 POST .../import/commit（targets: llm+rag，RAG 侧自动 rebuildIndex）
 *   → 问题管理页 IndexStatusPill「重建索引」可手动再建（可选）
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { flushSync } from "react-dom";
import DOMPurify from "dompurify";
import { apiJson, sseStepText, streamDocumentExtract } from "../api/client";
import { DocumentEditorPane, type DocumentContent } from "../components/DocumentEditorPane";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { TimingsPanel, TokenPanel, EXTRACT_PHASE_LABELS } from "../components/MetricsPanels";
import { Dropdown } from "../components/Dropdown";
import { useAppUi } from "../context/AppUiContext";
import type { AskTimings, FileTreeNode, ImportSelection } from "../types";
import {
  UPLOAD_ACCEPT,
  canConvertKind,
  CONVERT_TOOLTIP,
  convertKindFor,
  defaultVlmRefineKind,
  vlmRefineRecommendedKind,
  isEditableKind,
  isPreviewOnlyKind,
  kindLabel,
  QUESTION_GEN_TOOLTIP,
} from "../utils/documentTypes";
import {
  LineViewer,
  displayFileName,
  documentTextForLines,
  renderFileTreeNodes,
  sliceMarkdownLines,
  sourceFileExists,
} from "../utils/importShared";
import { ImportTargetSwitch } from "../components/ImportTargetSwitch";
import { useKnowledgeBases, useRagKnowledgeBases } from "../hooks/useKnowledgeBases";

export function ManageFilesView() {
  const { showToast } = useAppUi();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [selected, setSelected] = useState<{ path: string; kind: string; name: string } | null>(null);
  const [docContent, setDocContent] = useState<DocumentContent | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [loadedContent, setLoadedContent] = useState("");
  const [editMode, setEditMode] = useState<"source" | "preview">("source");
  const [extractOpen, setExtractOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [docLoading, setDocLoading] = useState(false);
  const loadSeqRef = useRef(0);

  // 加载文件树
  const loadTree = useCallback(async () => {
    const data = await apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree");
    setTree(data.tree || []);
  }, []);

  useEffect(() => { void loadTree(); }, [loadTree]);

  // 加载文档
  const loadDocument = async (node: FileTreeNode, seq: number) => {
    if (node.kind === "source_pdf") {
      if (seq !== loadSeqRef.current) return;
      setLoadedContent("");
      return;
    }
    const data = await apiJson<DocumentContent>(`/markdown-files/content?path=${encodeURIComponent(node.path!)}`);
    if (seq !== loadSeqRef.current) return;
    const text = documentTextForLines(data);
    setDocContent(data);
    setMarkdown(text);
    setLoadedContent(text);
    setEditMode(isPreviewOnlyKind(node.kind || "") ? "preview" : "source");
  };

  // 选择文件
  const selectFile = async (node: FileTreeNode) => {
    const editable = isEditableKind(node.kind || "");
    if (selected?.path !== node.path && editable && markdown !== loadedContent) {
      if (!confirm("当前文件有未保存修改，切换文件将丢失。是否继续？")) return;
    }
    const seq = ++loadSeqRef.current;
    setSelected({ path: node.path!, kind: node.kind || "", name: node.name });
    setDocContent(null);
    setMarkdown("");
    setDocLoading(true);
    setEditMode(node.kind === "source_pdf" || isPreviewOnlyKind(node.kind || "") ? "preview" : "source");
    try {
      await loadDocument(node, seq);
    } catch (e) {
      if (seq === loadSeqRef.current) showToast((e as Error).message, "error");
    } finally {
      if (seq === loadSeqRef.current) setDocLoading(false);
    }
  };

  // 保存 Markdown
  const saveMd = async () => {
    if (!selected || !isEditableKind(selected.kind)) return showToast("该文件不可编辑", "error");
    setSaving(true);
    try {
      await apiJson("/markdown-files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected.path, markdown }),
      });
      setLoadedContent(markdown);
      showToast("已保存");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  // 创建 Markdown
  const createMd = async () => {
    const name = prompt("新建 Markdown 文件名（不含路径）", "new.md");
    if (!name?.trim()) return;
    const fileName = name.trim().includes("/") ? name.trim().split("/").pop()! : name.trim();
    try {
      const data = await apiJson<{ path: string; kind: string }>("/markdown-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fileName, markdown: "" }),
      });
      await loadTree();
      setSelected({ path: data.path, kind: data.kind || "module_md", name: fileName });
      setMarkdown("");
      setLoadedContent("");
      setDocContent(null);
      showToast("已创建");
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  };

  // 重命名文件
  const renameFile = async () => {
    if (!selected) return;
    const newName = prompt("新文件名", selected.name);
    if (!newName?.trim()) return;
    try {
      const data = await apiJson<{ path: string; name: string }>("/markdown-files/rename", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected.path, name: newName.trim() }),
      });
      await loadTree();
      setSelected({ path: data.path, kind: selected.kind, name: data.name || newName.trim() });
      showToast("已重命名");
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  };

  // 删除文件
  const deleteFile = async () => {
    if (!selected || !confirm(`确定删除 ${selected.name}？`)) return;
    try {
      await apiJson(`/markdown-files?path=${encodeURIComponent(selected.path)}`, { method: "DELETE" });
      setSelected(null);
      setMarkdown("");
      setLoadedContent("");
      setDocContent(null);
      await loadTree();
      showToast("已删除");
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  };

  /** 上传源文件到 files/documents/sources/，成功后刷新左侧文件树 */
  const uploadFile = async (file: File, overwrite = false) => {
    setUploading(true);
    try {
      let ow = overwrite;
      const baseName = file.name.trim();
      if (!ow && sourceFileExists(tree, baseName)) {
        if (!confirm(`文件「${baseName}」已存在，是否覆盖？\n\n覆盖后原文件内容将无法恢复。`)) return;
        ow = true;
      }
      const fd = new FormData();
      fd.append("file", file);
      if (ow) fd.append("overwrite", "1");
      const qs = ow ? "?overwrite=1" : "";
      const r = await fetch(`/documents/upload${qs}`, { method: "POST", body: fd });
      const txt = await r.text();
      let data: { detail?: string; exists?: boolean } | null = null;
      try {
        data = JSON.parse(txt) as { detail?: string; exists?: boolean };
      } catch {
        /* non-json */
      }
      if (r.status === 409 && data?.exists) {
        if (!confirm(`文件「${baseName}」已存在，是否覆盖？\n\n覆盖后原文件内容将无法恢复。`)) return;
        const fd2 = new FormData();
        fd2.append("file", file);
        fd2.append("overwrite", "1");
        const r2 = await fetch("/documents/upload?overwrite=1", { method: "POST", body: fd2 });
        const txt2 = await r2.text();
        let data2: { detail?: string } | null = null;
        try { data2 = JSON.parse(txt2) as { detail?: string }; } catch { /* */ }
        if (!r2.ok) throw new Error(data2?.detail || txt2 || r2.statusText);
      } else if (!r.ok) {
        throw new Error(data?.detail || txt || r.statusText);
      }
      await loadTree();
      showToast(ow ? "已覆盖上传" : "上传成功");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setUploading(false);
    }
  };

  // 文件类型
  const kind = selected?.kind || "";
  // 预览模式
  const previewOnly = isPreviewOnlyKind(kind);
  // 可编辑
  const editable = isEditableKind(kind);
  const lineCount = markdown ? markdown.split("\n").length : docContent?.line_count || 0;

  const handleExtracted = (result: { path?: string; markdown?: string; module_path?: string }) => {
    const outPath = result.path || result.module_path || "";
    if (result.markdown) {
      setMarkdown(result.markdown);
      setLoadedContent(result.markdown);
    }
    if (outPath) {
      setSelected({ path: outPath, kind: "module_md", name: outPath.split("/").pop() || "" });
      setDocContent({ path: outPath, kind: "module_md", markdown: result.markdown, editable: true });
      setEditMode("source");
    }
  };

  return (
    <div className="filesPage panel">
      <div className="stripHead">
        <span id="filesSelectedLabel" className={`${selected ? "" : "muted "}filesSelectedLabel`}>
          {selected ? `${kindLabel(kind)}：${selected.name}` : "未选择文件"}
        </span>
        <span className="headActions">
          <button type="button" id="filesToolbarUpload" className={`btn btnXs primary${uploading ? " btnRunning" : ""}`} disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? "上传中…" : "上传文件"}</button>
          <button type="button" id="filesToolbarExtract" className="btn btnXs" title={CONVERT_TOOLTIP} onClick={() => setExtractOpen(true)}>文件转 Markdown</button>
          <button type="button" id="filesToolbarGenerate" className="btn btnXs" title={QUESTION_GEN_TOOLTIP} onClick={() => setGenerateOpen(true)}>问题生成</button>
          <button type="button" id="filesToolbarRefresh" className="btn btnXs ghost" onClick={() => void loadTree()}>刷新</button>
          <button type="button" id="filesMainSaveBtn" className="btn btnXs primary" disabled={!editable || !selected || saving} onClick={() => void saveMd()}>{saving ? "保存中…" : "保存"}</button>
          <Dropdown label="操作" primary={false}>
            <button type="button" className="dropdownItem" data-files-action="newMd" onClick={() => void createMd()}>新建 MD</button>
            <button type="button" className="dropdownItem" data-files-action="rename" disabled={!selected} onClick={() => void renameFile()}>重命名</button>
            <div className="dropdownDivider" />
            <button type="button" className="dropdownItem danger" data-files-action="delete" disabled={!selected} onClick={() => void deleteFile()}>删除</button>
          </Dropdown>
        </span>
      </div>
      <div className="filesLayout">
        <aside className="filesTreeCol">
          <div className="stripHead"><span>文件</span></div>
          <div id="filesTree" className="fileTree scrollInner">{renderFileTreeNodes(tree, selected?.path || "", selectFile)}</div>
        </aside>
        <section className="filesEditorCol">
          <div className="uploadPhaseHead stripHead">
            <span className="uploadPhaseTitle" id="filesEditorTitle">{previewOnly ? "文件预览" : "文件编辑"}</span>
            <span id="filesEditLineCountLabel" className="muted">{lineCount ? `${lineCount} 行` : ""}</span>
            <div className="segmentedControl" id="filesEditSegment">
              {!previewOnly && (
                <button type="button" className={`segmentedBtn ${editMode === "source" ? "active" : ""}`} id="filesEditTabSource" onClick={() => setEditMode("source")}>编辑</button>
              )}
              <button type="button" className={`segmentedBtn ${editMode === "preview" ? "active" : ""}`} id="filesEditTabPreview" onClick={() => setEditMode("preview")}>预览</button>
            </div>
          </div>
          {previewOnly && (
            <div className="filesPdfHint muted">此格式不可直接编辑，请使用「文件转 Markdown」转换后在 modules 中编辑。</div>
          )}
          <div className="uploadEditBody filesEditBody">
            <div className={`uploadEditPane active`}>
              <DocumentEditorPane
                selected={selected}
                content={docContent}
                editMode={editMode}
                text={markdown}
                loading={docLoading}
                onChange={setMarkdown}
              />
            </div>
          </div>
        </section>
      </div>
      <input ref={fileInputRef} id="filesFileInput" type="file" accept={UPLOAD_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />

      {/* 文件转 Markdown */}
      {extractOpen && (
        <ExtractModal
          open
          onClose={() => setExtractOpen(false)}
          initialPath={selected && canConvertKind(selected.kind) ? selected.path : ""}
          initialKind={selected && canConvertKind(selected.kind) ? selected.kind : ""}
          initialName={selected && canConvertKind(selected.kind) ? selected.name : ""}
          onExtracted={handleExtracted}
          onTreeReload={() => void loadTree()}
        />
      )}

      {generateOpen && (
        <GenerateModal
          open
          onClose={() => setGenerateOpen(false)}
          initialPath={selected?.path || ""}
          initialName={selected?.name || ""}
          initialMarkdown={markdown}
          onCommitted={() => void loadTree()}
        />
      )}
    </div>
  );
}

type ExtractRange = { id: string; start: number; end: number };

function newExtractRange(start: number, end: number): ExtractRange {
  return { id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, start, end };
}

function extractHighlightProps(
  ranges: ExtractRange[],
  activeRangeId: string,
) {
  const active = ranges.find((r) => r.id === activeRangeId) || ranges[0];
  if (!active) return {};
  return {
    lineStart: active.start,
    lineEnd: active.end,
    activeSelectionId: active.id,
    selections: ranges.map((r) => ({ id: r.id, lineStart: r.start, lineEnd: r.end })),
  };
}

function ExtractModal({
  open,
  onClose,
  initialPath,
  initialKind,
  initialName,
  onExtracted,
  onTreeReload,
}: {
  open: boolean;
  onClose: () => void;
  initialPath?: string;
  initialKind?: string;
  initialName?: string;
  onExtracted: (result: { path?: string; markdown?: string; module_path?: string }) => void;
  onTreeReload: () => void;
}) {
  const { showToast } = useAppUi();
  const progressRef = useRef<HTMLDivElement>(null);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [path, setPath] = useState(initialPath || "");
  const [fileKind, setFileKind] = useState(initialKind || "");
  const [fileName, setFileName] = useState(initialName || "");
  const [md, setMd] = useState("");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"source" | "preview">("preview");
  const [extractRanges, setExtractRanges] = useState<ExtractRange[]>([newExtractRange(1, 5)]);
  const [activeRangeId, setActiveRangeId] = useState("");
  const [extractSheet, setExtractSheet] = useState("");
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [useVlmRefine, setUseVlmRefine] = useState(() => defaultVlmRefineKind(initialKind || ""));
  const [extractLog, setExtractLog] = useState<string[]>([]);
  const [extractWarnings, setExtractWarnings] = useState<string[]>([]);
  const [extractErrors, setExtractErrors] = useState<string[]>([]);
  const [extractMetrics, setExtractMetrics] = useState<AskTimings | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractDone, setExtractDone] = useState(false);

  const convertKind = fileKind ? convertKindFor(fileKind) : "";
  const showRangePicker = !!path && convertKind !== "whole_sheet";
  const rangeTitle = convertKind === "pdf_pages" ? "页码范围" : "行范围";
  const rangeUnit = convertKind === "pdf_pages" ? "页" : "行";
  const highlight = extractHighlightProps(extractRanges, activeRangeId);

  useEffect(() => {
    if (!open) return;
    setUseVlmRefine(defaultVlmRefineKind(initialKind || ""));
    void apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree").then((d) => setTree(d.tree || []));
    if (initialPath) void selectModalFile(initialPath, initialKind || "", initialName || "");
  }, [open, initialPath, initialKind, initialName]);

  useEffect(() => {
    const el = progressRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [extractLog, extractErrors, extractWarnings]);

  const resetExtractProgress = () => {
    setExtractLog([]);
    setExtractWarnings([]);
    setExtractErrors([]);
    setExtractMetrics(null);
    setExtractDone(false);
  };

  const loadPreview = async (p: string, kind: string) => {
    if (kind === "source_pdf") {
      setMd("");
      setPreviewHtml(null);
      setViewMode("preview");
      return { lineCount: 0 };
    }
    const data = await apiJson<DocumentContent>(`/markdown-files/content?path=${encodeURIComponent(p)}`);
    const text = documentTextForLines(data);
    setMd(text);
    setPreviewHtml(data.preview_html || null);
    setViewMode(isPreviewOnlyKind(kind) ? "preview" : "source");
    return { lineCount: text ? text.split("\n").length : (data.line_count || 0) };
  };

  const setupRangesForKind = async (
    kind: string,
    name: string,
    lineCount = 0,
    caps?: FileTreeNode["capabilities"],
  ) => {
    setUseVlmRefine(defaultVlmRefineKind(kind, caps));
    if (["source_xlsx", "source_xls", "source_csv"].includes(kind)) {
      try {
        const data = await apiJson<{ sheets: string[] }>(`/documents/excel-sheets?filename=${encodeURIComponent(name)}`);
        setSheetNames(data.sheets || []);
        setExtractSheet(data.sheets?.[0] || "");
      } catch {
        setSheetNames([]);
        setExtractSheet("");
      }
      setExtractRanges([]);
      setActiveRangeId("");
      return;
    }
    setSheetNames([]);
    setExtractSheet("");
    const end = Math.min(5, lineCount || 5);
    const first = newExtractRange(1, end);
    setExtractRanges([first]);
    setActiveRangeId(first.id);
  };

  const selectModalFile = async (
    p: string,
    kind: string,
    name: string,
    caps?: FileTreeNode["capabilities"],
  ) => {
    if (!canConvertKind(kind)) {
      showToast("该文件类型不可转换", "error");
      return;
    }
    setPath(p);
    setFileKind(kind);
    setFileName(name);
    setMd("");
    setPreviewHtml(null);
    resetExtractProgress();
    try {
      const preview = await loadPreview(p, kind);
      await setupRangesForKind(kind, name, preview.lineCount, caps);
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  };

  /** SSE 流式提取：多段 ranges 合并为一个 module_md，use_vlm_refine 控制模型智能整理 */
  const runExtract = async () => {
    if (!path || !fileKind || extracting) return;
    if (!canConvertKind(fileKind)) return showToast("请选择可转换的文件", "error");
    const filename = path.split("/").pop() || fileName;
    resetExtractProgress();
    setExtracting(true);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    try {
      const body: Record<string, unknown> = {
        filename,
        use_vlm_refine: useVlmRefine,
      };
      if (convertKind === "whole_sheet") {
        body.ranges = [[1, 99999]];
        if (extractSheet) body.sheet_name = extractSheet;
      } else {
        body.ranges = extractRanges.map((r) => [Math.max(1, r.start), Math.max(r.start, r.end)]);
      }

      await streamDocumentExtract(body, (evt) => {
        if (evt.event === "log") {
          const line = sseStepText(evt.data as Record<string, unknown>);
          if (line) {
            flushSync(() => setExtractLog((prev) => [...prev, line]));
          }
        }
        if (evt.event === "error") {
          const msg = String((evt.data as { detail?: string }).detail || "转换失败");
          flushSync(() => setExtractErrors((prev) => [...prev, msg]));
        }
        if (evt.event === "done") {
          const d = evt.data as {
            markdown?: string;
            path?: string;
            module_path?: string;
            timings?: AskTimings;
            tokens?: AskTimings["tokens"];
            token_breakdown?: AskTimings["token_breakdown"];
            warnings?: string[];
          };
          if (d.warnings?.length) setExtractWarnings(d.warnings);
          const timings = d.timings
            ? {
                ...d.timings,
                tokens: d.timings.tokens ?? d.tokens,
                token_breakdown: d.timings.token_breakdown ?? d.token_breakdown,
              }
            : null;
          setExtractMetrics(timings);
          setExtractDone(true);
          onExtracted(d);
          onTreeReload();
          showToast("提取完成");
        }
      });
    } catch (e) {
      const msg = (e as Error).message;
      setExtractErrors((prev) => [...prev, msg]);
      showToast(msg, "error");
    } finally {
      setExtracting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modalOverlay" id="extractModalOverlay">
      <div className="modal modalWide modalTall workflowModalFixed">
        <div className="modalHead">
          <span>文件转 Markdown</span>
          <span className="headActions">
            <button
              type="button"
              id="filesExtractBtn"
              className={`btn btnXs primary${extracting ? " btnRunning" : ""}`}
              disabled={extracting || !path || !canConvertKind(fileKind)}
              onClick={() => void runExtract()}
            >
              {extracting ? "转换中…" : "转换"}
            </button>
            <button type="button" id="extractModalCloseBtn" className="btn btnXs ghost" disabled={extracting} onClick={onClose}>关闭</button>
          </span>
        </div>
        <div className="modalBody generateModalBody">
          <p className="extractFidelityNote muted">转换保留正文与图片，模型整理可提高可读性，不保证版式与原文件一致。</p>
          <div className="generateToolbar stripHead modalToolbarRow">
            <button type="button" id="extractRefreshTreeBtn" className="btn btnXs ghost" onClick={() => void apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree").then((d) => setTree(d.tree || []))}>刷新文件</button>
            <span id="extractModalFileLabel" className="muted generateFileLabel">{displayFileName(path, fileName) || "未选择文件"}</span>
          </div>
          <div className="modalToolbarDivider" />
          <div className="uploadSelectLayout generateLayout extractModalLayout workflowModalBody">
            <aside className="generateTreeCol">
              <div className="stripHead"><span>文件</span></div>
              <div id="extractFileTree" className="fileTree scrollInner">
                {renderFileTreeNodes(tree, path, (n) => { if (n.path && n.kind) void selectModalFile(n.path, n.kind, n.name, n.capabilities); }, "convert")}
              </div>
            </aside>
            <aside className="uploadSelectLeft extractRangeCol">
              {path && (
                <label className="extractVlmToggle">
                  <input type="checkbox" checked={useVlmRefine} disabled={extracting} onChange={(e) => setUseVlmRefine(e.target.checked)} />
                  模型智能整理{vlmRefineRecommendedKind(fileKind) ? "（推荐）" : ""}
                </label>
              )}
              {convertKind === "pdf_pages" && (
                <p className="muted extractVlmNote">PDF 提取已内置版面整理，上方选项对 PDF 不生效。</p>
              )}
              {fileKind === "source_docx" && (
                <p className="muted extractVlmNote">Word 按 Markdown 行号选段；含图片段落以链接形式保留。</p>
              )}
              {convertKind === "whole_sheet" && (
                <>
                  <p className="muted">将转换整个工作表为 Markdown 表格，通常无需模型整理。</p>
                  {sheetNames.length > 0 && (
                    <label className="fieldLabel">工作表
                      <select className="kbSelect" value={extractSheet} disabled={extracting} onChange={(e) => setExtractSheet(e.target.value)}>
                        {sheetNames.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </label>
                  )}
                </>
              )}
              {showRangePicker && (
                <div id="filesExtractRange" className="uploadRangeBlock extractRangeBlock">
                  <div className="uploadRangeHead filesPdfRangeHead">
                    <span className="uploadRangeTitle">{rangeTitle}</span>
                    <button
                      type="button"
                      className="btn btnXs ghost"
                      disabled={extracting}
                      onClick={() => {
                        const last = extractRanges[extractRanges.length - 1];
                        const next = newExtractRange(last ? last.end + 1 : 1, last ? last.end + 3 : 5);
                        setExtractRanges([...extractRanges, next]);
                        setActiveRangeId(next.id);
                      }}
                    >
                      + 添加范围
                    </button>
                  </div>
                  <div className="extractRangeList">
                    {extractRanges.map((r) => (
                      <div
                        key={r.id}
                        className={`extractRangeCard${activeRangeId === r.id ? " active" : ""}`}
                        onClick={() => {
                          setActiveRangeId(r.id);
                          if (fileKind !== "source_pdf") setViewMode("source");
                        }}
                      >
                        <div className="extractRangeCardMain">
                          <span>从</span>
                          <input
                            type="number"
                            value={r.start}
                            min={1}
                            disabled={extracting}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10);
                              setExtractRanges(extractRanges.map((x) => (x.id === r.id ? { ...x, start: val } : x)));
                            }}
                          />
                          <span>到</span>
                          <input
                            type="number"
                            value={r.end}
                            min={1}
                            disabled={extracting}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10);
                              setExtractRanges(extractRanges.map((x) => (x.id === r.id ? { ...x, end: val } : x)));
                            }}
                          />
                          <span className="muted">{rangeUnit}</span>
                        </div>
                        {extractRanges.length > 1 && (
                          <button
                            type="button"
                            className="btn btnXs ghost extractRangeCardDelete"
                            disabled={extracting}
                            onClick={(e) => {
                              e.stopPropagation();
                              const next = extractRanges.filter((x) => x.id !== r.id);
                              setExtractRanges(next);
                              if (activeRangeId === r.id) setActiveRangeId(next[0]?.id || "");
                            }}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!path && <p className="muted extractRangeEmpty">请从左侧选择要转换的文件</p>}
            </aside>
            <section className="uploadSelectRight generateMdCol">
              <div className="stripHead generateMdHead">
                <span>文件内容</span>
                <div className="segmented generateMdTabs">
                  <button type="button" className={`segmentedBtn${viewMode === "source" ? " active" : ""}`} onClick={() => setViewMode("source")}>源码</button>
                  <button type="button" className={`segmentedBtn${viewMode === "preview" ? " active" : ""}`} onClick={() => setViewMode("preview")}>预览</button>
                </div>
              </div>
              <div id="extractMdViewer" className="generateMdViewer scrollInner">
                {!path ? (
                  <div className="muted filesEmptyHint">从左侧选择文件…</div>
                ) : fileKind === "source_pdf" && viewMode === "preview" ? (
                  <iframe title={fileName} className="filesPdfPreview" src={`/documents/preview-file?path=${encodeURIComponent(path)}`} />
                ) : viewMode === "source" ? (
                  <LineViewer
                    markdown={md}
                    lineStart={highlight.lineStart}
                    lineEnd={highlight.lineEnd}
                    activeSelectionId={highlight.activeSelectionId}
                    selections={highlight.selections}
                  />
                ) : fileKind === "source_json" ? (
                  <pre className="jsonPreview">{md}</pre>
                ) : previewHtml ? (
                  <div className="docPreviewHtml mdPreview" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml) }} />
                ) : md ? (
                  <div className="generateMdPreview mdPreview"><MarkdownPreview md={md} kbId="documents" /></div>
                ) : (
                  <div className="muted filesEmptyHint">暂无预览内容</div>
                )}
              </div>
            </section>
          </div>
          {(extracting || extractLog.length > 0 || extractErrors.length > 0 || extractWarnings.length > 0 || extractDone) && (
            <div id="filesProgress" ref={progressRef} className="importProgress importProgressModal extractProgressPanel">
              {extractLog.map((line, i) => <div key={`log-${i}`} className="importLogLine">{line}</div>)}
              {extractErrors.map((line, i) => <div key={`err-${i}`} className="importLogLine extractLogError">{line}</div>)}
              {extractWarnings.map((line, i) => <div key={`warn-${i}`} className="importLogLine extractLogWarn">{line}</div>)}
              {extracting && extractLog.length === 0 && <div className="importLogLine">正在准备…</div>}
              {extractDone && !extracting && <div className="importLogLine extractLogDone">转换完成</div>}
            </div>
          )}
          {(extractDone || extractMetrics) && (
            <div className="workflowMetrics">
              <div className="workflowMetricsHead muted">消耗时间</div>
              <div id="extractModalTimingPanel" className="timingPanel"><TimingsPanel timings={extractMetrics} emptyText="转换完成后显示" mode="extract" /></div>
              <div className="workflowMetricsHead muted">消耗 Token</div>
              <div id="extractModalTokenPanel" className="tokenPanel"><TokenPanel timings={extractMetrics} emptyText="转换完成后显示" phaseLabels={EXTRACT_PHASE_LABELS} /></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GenerateModal({ open, onClose, initialPath, initialName, initialMarkdown, onCommitted }: {
  open: boolean; onClose: () => void; initialPath?: string; initialName?: string; initialMarkdown?: string; onCommitted: () => void;
}) {
  const { showToast } = useAppUi();
  const { kbMap } = useKnowledgeBases();
  const { kbMap: ragKbMap } = useRagKnowledgeBases();
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [llmKbId, setLlmKbId] = useState("");
  const [ragKbId, setRagKbId] = useState("");
  const [path, setPath] = useState(initialPath || "");
  const [fileName, setFileName] = useState(initialName || "");
  const [md, setMd] = useState(initialMarkdown || "");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [fileKindState, setFileKindState] = useState("");
  const [lineStart, setLineStart] = useState(1);
  const [lineEnd, setLineEnd] = useState(10);
  const [selections, setSelections] = useState<ImportSelection[]>([]);
  const [activeSelectionId, setActiveSelectionId] = useState("");
  const [importLlm, setImportLlm] = useState(true);
  const [importRag, setImportRag] = useState(false);
  const [metrics, setMetrics] = useState<AskTimings | null>(null);
  const [generatingId, setGeneratingId] = useState("");
  const [importing, setImporting] = useState(false);
  const [mdViewMode, setMdViewMode] = useState<"source" | "preview">("source");
  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));
  const ragKbIds = Object.keys(ragKbMap).sort((a, b) => Number(a) - Number(b));

  // 初始化
  useEffect(() => {
    if (!open) return;
    void apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree").then((d) => setTree(d.tree || []));
    if (!llmKbId && kbIds.length) setLlmKbId(kbIds[0]);
    if (!ragKbId && ragKbIds.length) setRagKbId(ragKbIds[0]);
    if (initialPath) void loadDocumentText(initialPath, initialMarkdown, initialName);
  }, [open, initialPath, initialName, initialMarkdown, kbIds.length, ragKbIds.length]);

  // 加载文档文本
  const loadDocumentText = async (p: string, fallbackMd?: string, name?: string) => {
    setMd("");
    setPreviewHtml(null);
    try {
      const data = await apiJson<DocumentContent>(`/markdown-files/content?path=${encodeURIComponent(p)}`); // 获取文档文本
      const text = documentTextForLines(data);
      setMd(text || fallbackMd || "");
      setPreviewHtml(data.preview_html || null);
      setFileKindState(data.kind || "");
      setPath(p); // 设置路径
      setFileName(name || data.display_name || displayFileName(p)); // 设置文件名
      const lc = text.split("\n").length;
      setLineEnd(Math.min(10, lc || 10)); // 设置行数
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  };

  // 添加选择
  const addSelection = () => {
    const id = `s_${Date.now()}`;
    setSelections([...selections, { id, lineStart, lineEnd, question: "", variants: [], answer: sliceMarkdownLines(md, lineStart, lineEnd) }]);
    setActiveSelectionId(id);
  };

  // 删除选择
  const removeSelection = (id: string) => {
    setSelections(selections.filter((s) => s.id !== id));
    if (activeSelectionId === id) setActiveSelectionId("");
  };

  // 更新选择
  const updateSelection = (id: string, patch: Partial<ImportSelection>) => {
    setSelections(selections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  // 自动生成问法
  const autoGenerate = async (sel: ImportSelection) => {
    if (generatingId) return;
    setGeneratingId(sel.id);
    const t0 = performance.now();
    try {
      const data = await apiJson<{ question: string; variants: string[] }>(`/knowledge-bases/${encodeURIComponent(llmKbId || kbIds[0] || "1")}/import/generate-questions`, { // 生成问法
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer_md: sel.answer }),
      });
      updateSelection(sel.id, { question: data.question, variants: data.variants || [] });
      setMetrics({ total_ms: performance.now() - t0 });
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setGeneratingId("");
    }
  };

  /** 提交生成的 FAQ 到 LLM/RAG 库；双选时一次 commit，RAG 侧默认 auto_rebuild_rag */
  const commit = async () => {
    if (importing) return;
    if (importLlm && !llmKbId) return showToast("请选择问答模型知识库", "error");
    if (importRag && !ragKbId) return showToast("请选择 RAG 知识库", "error");
    if (!importLlm && !importRag) return showToast("请至少选择一个导入目标", "error");
    const items = selections.filter((s) => s.question.trim());
    if (!items.length) return showToast("请至少添加一条有效选择", "error");
    const targets: string[] = [];
    if (importLlm) targets.push("llm");
    if (importRag) targets.push("rag");
    setImporting(true);
    try {
      await apiJson(`/knowledge-bases/${encodeURIComponent(importLlm ? llmKbId : ragKbId)}/import/commit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((s) => ({ question: s.question, variants: s.variants, answer: s.answer, enabled: true })),
          append: true,
          targets,
          rag_kb_id: importRag ? ragKbId : undefined,
        }),
      });
      showToast(`已导入 ${items.length} 条${importLlm && importRag ? "（问答模型 + RAG）" : importRag ? "（RAG）" : "（问答模型）"}`);
      onCommitted();
      onClose();
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modalOverlay" id="generateModalOverlay">
      <div className="modal modalWide modalTall workflowModalFixed">
        <div className="modalHead">
          <span>问题生成</span>
          <button type="button" id="generateModalCloseBtn" className="btn btnXs ghost" disabled={importing || !!generatingId} onClick={onClose}>关闭</button>
        </div>
        <div className="modalBody generateModalBody">
          <div className="modeBar">
            <span className="modeBarLabel">导入目标</span>
            <div className="importTargetRow">
              <ImportTargetSwitch label="导入到问答模型" checked={importLlm} onChange={setImportLlm} />
              <ImportTargetSwitch label="导入到 RAG" checked={importRag} onChange={setImportRag} />
            </div>
          </div>
          <div className="modeBarDivider" />
          {fileKindState === "source_docx" && (
            <p className="muted generateDocxHint">Word 文本提取用于选行；含图片段落以 Markdown 链接形式保留。</p>
          )}
          <div className="generateToolbar stripHead modalToolbarRow">
            {importLlm && (
              <label className="kbSelectLabel">问答模型 KB<select className="kbSelect" value={llmKbId} onChange={(e) => setLlmKbId(e.target.value)}>{kbIds.map((id) => <option key={id} value={id}>{kbMap[id]?.name || id}</option>)}</select></label>
            )}
            {importRag && (
              <label className="kbSelectLabel">RAG KB<select className="kbSelect" value={ragKbId} onChange={(e) => setRagKbId(e.target.value)}>{ragKbIds.map((id) => <option key={id} value={id}>{ragKbMap[id]?.name || id}</option>)}</select></label>
            )}
            <button type="button" id="generateRefreshTreeBtn" className="btn btnXs ghost" onClick={() => void apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree").then((d) => setTree(d.tree || []))}>刷新文件</button>
            <span id="generateFileLabel" className="muted generateFileLabel">{displayFileName(path, fileName) || "未选择文件"}</span>
            <span className="headActions" style={{ marginLeft: "auto" }}>
              <button type="button" id="generateCommitBtn" className={`btn btnXs primary${importing ? " btnRunning" : ""}`} disabled={importing || !!generatingId} onClick={() => void commit()}>{importing ? "导入中…" : "导入"}</button>
            </span>
          </div>
          <div className="modalToolbarDivider" />
          <div className="uploadSelectLayout generateLayout generateModalLayout workflowModalBody">
            <aside className="generateTreeCol">
              <div className="stripHead"><span>文件</span></div>
              <div id="generateFileTree" className="fileTree scrollInner">{renderFileTreeNodes(tree, path, (n) => { if (n.path) void loadDocumentText(n.path, undefined, n.name); }, "questionGen")}</div>
            </aside>
            <aside className="uploadSelectLeft generateRangeCol">
              <div className="uploadPhaseHead stripHead">
                <span className="uploadPhaseTitle">选择行范围</span>
                <button type="button" id="generateAddSelectionBtn" className="btn btnXs primary" disabled={importing || !!generatingId} onClick={addSelection}>添加选择</button>
              </div>
              <div className="generateRangeRow">
                <input type="number" id="generateSelLineStart" value={lineStart} min={1} onChange={(e) => setLineStart(parseInt(e.target.value, 10))} />
                <span>–</span>
                <input type="number" id="generateSelLineEnd" value={lineEnd} min={1} onChange={(e) => setLineEnd(parseInt(e.target.value, 10))} />
              </div>
              <div id="generateSelectionsList" className="uploadSelectionsList">
                {selections.map((s) => (
                  <div
                    key={s.id}
                    className={`uploadSelectionCard${activeSelectionId === s.id ? " active" : ""}`}
                    onClick={() => { setActiveSelectionId(s.id); setMdViewMode("source"); }}
                  >
                    <div className="uploadSelectionHead">
                      <span className="uploadSelectionTitle">第 {s.lineStart}–{s.lineEnd} 行</span>
                      <button
                        type="button"
                        className="btn btnXs ghost uploadSelectionDelete"
                        onClick={(e) => { e.stopPropagation(); removeSelection(s.id); }}
                        disabled={!!generatingId || importing}
                      >
                        删除
                      </button>
                    </div>
                    <div className="uploadSelectionActions">
                      <button type="button" className="btn btnXs ghost" onClick={(e) => { e.stopPropagation(); setActiveSelectionId(s.id); setMdViewMode("source"); }} disabled={!!generatingId || importing}>高亮</button>
                      <button type="button" className={`btn btnXs primary${generatingId === s.id ? " btnRunning" : ""}`} disabled={!!generatingId || importing} onClick={(e) => { e.stopPropagation(); void autoGenerate(s); }}>{generatingId === s.id ? "生成中…" : "自动生成问法"}</button>
                    </div>
                    <label className="fieldLabel uploadSelectionField">标准问题
                      <input className="settingsInput importSelQuestion" value={s.question} placeholder="输入标准问题" onChange={(e) => updateSelection(s.id, { question: e.target.value })} />
                    </label>
                    <label className="fieldLabel uploadSelectionField">其他问法（每行一条）
                      <textarea className="settingsTextarea importSelVariants" rows={3} value={(s.variants || []).join("\n")} placeholder="每行一条其他问法" onChange={(e) => updateSelection(s.id, { variants: e.target.value.split("\n").filter(Boolean) })} />
                    </label>
                  </div>
                ))}
              </div>
              {metrics && (
                <div className="workflowMetrics">
                  <div id="generateModalTimingPanel" className="timingPanel"><TimingsPanel timings={metrics} mode="import" /></div>
                </div>
              )}
            </aside>
            <section className="uploadSelectRight generateMdCol">
              <div className="stripHead generateMdHead">
                <span>文件内容</span>
                <div className="segmented generateMdTabs">
                  <button type="button" className={`segmentedBtn${mdViewMode === "source" ? " active" : ""}`} onClick={() => setMdViewMode("source")}>源码</button>
                  <button type="button" className={`segmentedBtn${mdViewMode === "preview" ? " active" : ""}`} onClick={() => setMdViewMode("preview")}>预览</button>
                </div>
              </div>
              <div id="generateMdViewer" className="generateMdViewer scrollInner">
                {mdViewMode === "source" ? (
                  <LineViewer markdown={md} lineStart={lineStart} lineEnd={lineEnd} activeSelectionId={activeSelectionId} selections={selections} />
                ) : fileKindState === "source_json" ? (
                  <pre className="jsonPreview">{md}</pre>
                ) : previewHtml ? (
                  <div className="docPreviewHtml mdPreview" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml) }} />
                ) : (
                  <div className="generateMdPreview mdPreview">
                    <MarkdownPreview md={md} kbId="documents" />
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
