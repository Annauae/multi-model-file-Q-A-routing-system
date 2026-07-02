import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import DOMPurify from "dompurify";
import { apiJson, sseStepText, streamDocumentExtract } from "../api/client";
import { DocumentEditorPane, type DocumentContent } from "../components/DocumentEditorPane";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { TimingsPanel, TokenPanel } from "../components/MetricsPanels";
import { Dropdown } from "../components/Dropdown";
import { useAppUi } from "../context/AppUiContext";
import type { AskTimings, FileTreeNode, ImportSelection } from "../types";
import {
  UPLOAD_ACCEPT,
  canConvertKind,
  canQuestionGenKind,
  convertKindFor,
  defaultVlmRefineKind,
  isEditableKind,
  isPreviewOnlyKind,
  kindLabel,
} from "../utils/documentTypes";
import {
  LineViewer,
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
  const [extractRanges, setExtractRanges] = useState([{ start: 1, end: 5 }]);
  const [extractSheet, setExtractSheet] = useState("");
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [useVlmRefine, setUseVlmRefine] = useState(true);
  const [extractLog, setExtractLog] = useState<string[]>([]);
  const [extractWarnings, setExtractWarnings] = useState<string[]>([]);
  const [extractMetrics, setExtractMetrics] = useState<AskTimings | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const extractProgressRef = useRef<HTMLDivElement>(null);

  const loadTree = useCallback(async () => {
    const data = await apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree");
    setTree(data.tree || []);
  }, []);

  useEffect(() => { void loadTree(); }, [loadTree]);

  useEffect(() => {
    const el = extractProgressRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [extractLog]);

  const loadDocument = async (node: FileTreeNode) => {
    if (node.kind === "source_pdf") {
      setDocContent(null);
      setMarkdown("");
      setLoadedContent("");
      setEditMode("preview");
      return;
    }
    const data = await apiJson<DocumentContent>(`/markdown-files/content?path=${encodeURIComponent(node.path!)}`);
    const text = documentTextForLines(data);
    setDocContent(data);
    setMarkdown(text);
    setLoadedContent(text);
    setEditMode(isPreviewOnlyKind(node.kind || "") ? "preview" : "source");
  };

  const selectFile = async (node: FileTreeNode) => {
    const editable = isEditableKind(node.kind || "");
    if (selected?.path !== node.path && editable && markdown !== loadedContent) {
      if (!confirm("当前文件有未保存修改，切换文件将丢失。是否继续？")) return;
    }
    setSelected({ path: node.path!, kind: node.kind || "", name: node.name });
    try {
      await loadDocument(node);
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  };

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

  const openExtract = async () => {
    if (!selected) return;
    setUseVlmRefine(defaultVlmRefineKind(selected.kind));
    setExtractRanges([{ start: 1, end: 5 }]);
    if (["source_xlsx", "source_xls", "source_csv"].includes(selected.kind)) {
      try {
        const data = await apiJson<{ sheets: string[] }>(`/documents/excel-sheets?filename=${encodeURIComponent(selected.name)}`);
        setSheetNames(data.sheets || []);
        setExtractSheet(data.sheets?.[0] || "");
        setExtractRanges([{ start: 1, end: 100 }]);
      } catch {
        setSheetNames([]);
        setExtractSheet("");
      }
    }
    setExtractOpen(true);
  };

  const runExtract = async () => {
    if (!selected?.path || extracting) return;
    const filename = selected.path.split("/").pop() || selected.name;
    const convertKind = convertKindFor(selected.kind);
    setExtractLog([]);
    setExtractWarnings([]);
    setExtractMetrics(null);
    setExtracting(true);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    try {
      const body: Record<string, unknown> = {
        filename,
        use_vlm_refine: useVlmRefine,
      };
      if (convertKind === "whole_doc") {
        body.ranges = [[1, 99999]];
      } else {
        body.ranges = extractRanges.map((r) => [Math.max(1, r.start), Math.max(r.start, r.end)]);
      }
      if (convertKind === "sheet_rows" && extractSheet)
        body.sheet_name = extractSheet;

      await streamDocumentExtract(body, (evt) => {
        if (evt.event === "log") {
          const line = sseStepText(evt.data as Record<string, unknown>);
          if (line) {
            flushSync(() => {
              setExtractLog((p) => [...p, line]);
            });
          }
        }
        if (evt.event === "done") {
          const d = evt.data as {
            markdown?: string;
            path?: string;
            module_path?: string;
            timings?: AskTimings;
            warnings?: string[];
          };
          const outPath = d.path || d.module_path || "";
          if (d.markdown) { setMarkdown(d.markdown); setLoadedContent(d.markdown); }
          if (d.warnings?.length) setExtractWarnings(d.warnings);
          if (outPath) {
            setSelected({ path: outPath, kind: "module_md", name: outPath.split("/").pop() || "" });
            setDocContent({ path: outPath, kind: "module_md", markdown: d.markdown, editable: true });
            setEditMode("source");
          }
          setExtractMetrics(d.timings || null);
          setExtractOpen(false);
          void loadTree();
          showToast(d.warnings?.length ? "提取完成（有提示）" : "提取完成");
        }
        if (evt.event === "error") showToast(String((evt.data as { detail?: string }).detail || "错误"), "error");
      });
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setExtracting(false);
    }
  };

  const kind = selected?.kind || "";
  const previewOnly = isPreviewOnlyKind(kind);
  const editable = isEditableKind(kind);
  const canConvert = selected ? canConvertKind(kind) : false;
  const canQuestionGen = selected ? canQuestionGenKind(kind) : false;
  const convertKind = selected ? convertKindFor(kind) : "";
  const lineCount = markdown ? markdown.split("\n").length : docContent?.line_count || 0;

  return (
    <div className="filesPage panel">
      <div className="stripHead">
        <span id="filesSelectedLabel" className={`${selected ? "" : "muted "}filesSelectedLabel`}>
          {selected ? `${kindLabel(kind)}：${selected.name}` : "未选择文件"}
        </span>
        <span className="headActions">
          <button type="button" id="filesToolbarUpload" className={`btn btnXs primary${uploading ? " btnRunning" : ""}`} disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? "上传中…" : "上传文件"}</button>
          <button type="button" id="filesToolbarExtract" className="btn btnXs" disabled={!canConvert} onClick={() => void openExtract()}>文件转 Markdown</button>
          <button type="button" id="filesToolbarGenerate" className="btn btnXs" disabled={!canQuestionGen} title={!canQuestionGen ? "PDF/Excel 需先转 Markdown" : ""} onClick={() => setGenerateOpen(true)}>问题生成</button>
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
                onChange={setMarkdown}
              />
            </div>
          </div>
        </section>
      </div>
      <input ref={fileInputRef} id="filesFileInput" type="file" accept={UPLOAD_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />

      {extractOpen && selected && (
        <div className="modalOverlay" id="extractModalOverlay">
          <div className="modal modalWide">
            <div className="modalHead">
              <span>文件转 Markdown</span>
              <button type="button" id="extractModalCloseBtn" className="btn btnXs ghost" disabled={extracting} onClick={() => setExtractOpen(false)}>关闭</button>
            </div>
            <div className="modalBody">
              <p className="extractFidelityNote muted">转换保留正文与图片，VLM 可提高可读性，不保证版式与原文件一致。</p>
              <p id="extractModalFileLabel" className="muted">{selected.name}</p>
              {convertKind === "pdf_pages" && (
                <p className="muted extractVlmNote">PDF 提取已内置 VLM 版面整理。</p>
              )}
              {convertKind !== "pdf_pages" && convertKind !== "whole_doc" && defaultVlmRefineKind(selected.kind) && (
                <label className="extractVlmToggle">
                  <input type="checkbox" checked={useVlmRefine} disabled={extracting} onChange={(e) => setUseVlmRefine(e.target.checked)} />
                  VLM 智能整理（推荐）
                </label>
              )}
              {convertKind === "whole_doc" && (
                <p className="muted">将转换整个 Word 文档为 Markdown。</p>
              )}
              {convertKind === "sheet_rows" && sheetNames.length > 0 && (
                <label className="fieldLabel">工作表
                  <select className="kbSelect" value={extractSheet} disabled={extracting} onChange={(e) => setExtractSheet(e.target.value)}>
                    {sheetNames.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              )}
              {convertKind !== "whole_doc" && (
                <div id="filesExtractRange" className="uploadRangeBlock">
                  <div className="uploadRangeHead filesPdfRangeHead">
                    <span className="uploadRangeTitle">
                      {convertKind === "pdf_pages" ? "PDF 页码范围" : convertKind === "sheet_rows" ? "Excel 行范围" : "行范围"}
                    </span>
                    {convertKind !== "sheet_rows" && (
                      <button type="button" className="btn btnXs ghost" disabled={extracting} onClick={() => setExtractRanges([...extractRanges, { start: extractRanges[extractRanges.length - 1].end + 1, end: extractRanges[extractRanges.length - 1].end + 3 }])}>+ 添加范围</button>
                    )}
                  </div>
                  <div className="rangeList">
                    {extractRanges.map((r, i) => (
                      <div key={i} className="rangeRow">
                        <span>从</span>
                        <input type="number" value={r.start} min={1} disabled={extracting} onChange={(e) => { const n = [...extractRanges]; n[i].start = parseInt(e.target.value, 10); setExtractRanges(n); }} />
                        <span>到</span>
                        <input type="number" value={r.end} min={1} disabled={extracting} onChange={(e) => { const n = [...extractRanges]; n[i].end = parseInt(e.target.value, 10); setExtractRanges(n); }} />
                        {extractRanges.length > 1 && convertKind !== "sheet_rows" && (
                          <button type="button" className="btn btnXs ghost" disabled={extracting} onClick={() => setExtractRanges(extractRanges.filter((_, j) => j !== i))}>删除</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <button
                type="button"
                id="filesExtractBtn"
                className={`btn btnXs primary${extracting ? " btnRunning" : ""}`}
                style={{ width: "100%", marginTop: 12 }}
                disabled={extracting}
                onClick={() => void runExtract()}
              >
                {extracting ? "转换中…" : "开始转换"}
              </button>
              {(extracting || extractLog.length > 0) && (
                <div id="filesProgress" ref={extractProgressRef} className="importProgress importProgressModal">
                  {extractLog.length > 0
                    ? extractLog.map((line, i) => <div key={i} className="importLogLine">{line}</div>)
                    : (extracting ? <div className="importLogLine">正在准备…</div> : null)}
                </div>
              )}
              {extractWarnings.length > 0 && (
                <div className="extractWarnings">
                  {extractWarnings.map((w, i) => <p key={i} className="muted">{w}</p>)}
                </div>
              )}
              <div className="workflowMetrics">
                <div className="workflowMetricsHead muted">消耗时间</div>
                <div id="extractModalTimingPanel" className="timingPanel"><TimingsPanel timings={extractMetrics} emptyText="转换完成后显示" mode="import" /></div>
                <div className="workflowMetricsHead muted">消耗 Token</div>
                <div id="extractModalTokenPanel" className="tokenPanel"><TokenPanel timings={extractMetrics} emptyText="转换完成后显示" /></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {generateOpen && (
        <GenerateModal
          open
          onClose={() => setGenerateOpen(false)}
          initialPath={canQuestionGen ? selected?.path : ""}
          initialMarkdown={canQuestionGen ? markdown : ""}
          onCommitted={() => void loadTree()}
        />
      )}
    </div>
  );
}

function GenerateModal({ open, onClose, initialPath, initialMarkdown, onCommitted }: {
  open: boolean; onClose: () => void; initialPath?: string; initialMarkdown?: string; onCommitted: () => void;
}) {
  const { showToast } = useAppUi();
  const { kbMap } = useKnowledgeBases();
  const { kbMap: ragKbMap } = useRagKnowledgeBases();
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [llmKbId, setLlmKbId] = useState("");
  const [ragKbId, setRagKbId] = useState("");
  const [path, setPath] = useState(initialPath || "");
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

  useEffect(() => {
    if (!open) return;
    void apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree").then((d) => setTree(d.tree || []));
    if (!llmKbId && kbIds.length) setLlmKbId(kbIds[0]);
    if (!ragKbId && ragKbIds.length) setRagKbId(ragKbIds[0]);
    if (initialPath) void loadDocumentText(initialPath, initialMarkdown);
  }, [open, initialPath, initialMarkdown, kbIds.length, ragKbIds.length]);

  const loadDocumentText = async (p: string, fallbackMd?: string) => {
    try {
      const data = await apiJson<DocumentContent>(`/markdown-files/content?path=${encodeURIComponent(p)}`);
      const text = documentTextForLines(data);
      setMd(text || fallbackMd || "");
      setPreviewHtml(data.preview_html || null);
      setFileKindState(data.kind || "");
      setPath(p);
      const lc = text.split("\n").length;
      setLineEnd(Math.min(10, lc || 10));
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  };

  const addSelection = () => {
    const id = `s_${Date.now()}`;
    setSelections([...selections, { id, lineStart, lineEnd, question: "", variants: [], answer: sliceMarkdownLines(md, lineStart, lineEnd) }]);
    setActiveSelectionId(id);
  };

  const removeSelection = (id: string) => {
    setSelections(selections.filter((s) => s.id !== id));
    if (activeSelectionId === id) setActiveSelectionId("");
  };

  const updateSelection = (id: string, patch: Partial<ImportSelection>) => {
    setSelections(selections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const autoGenerate = async (sel: ImportSelection) => {
    if (generatingId) return;
    setGeneratingId(sel.id);
    const t0 = performance.now();
    try {
      const data = await apiJson<{ question: string; variants: string[] }>(`/knowledge-bases/${encodeURIComponent(llmKbId || kbIds[0] || "1")}/import/generate-questions`, {
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
      <div className="modal modalWide modalTall">
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
          <div className="generateToolbar stripHead" style={{ border: "none", padding: "0 0 10px" }}>
            {importLlm && (
              <label className="kbSelectLabel">问答模型 KB<select className="kbSelect" value={llmKbId} onChange={(e) => setLlmKbId(e.target.value)}>{kbIds.map((id) => <option key={id} value={id}>{kbMap[id]?.name || id}</option>)}</select></label>
            )}
            {importRag && (
              <label className="kbSelectLabel">RAG KB<select className="kbSelect" value={ragKbId} onChange={(e) => setRagKbId(e.target.value)}>{ragKbIds.map((id) => <option key={id} value={id}>{ragKbMap[id]?.name || id}</option>)}</select></label>
            )}
            <button type="button" id="generateRefreshTreeBtn" className="btn btnXs ghost" onClick={() => void apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree").then((d) => setTree(d.tree || []))}>刷新文件</button>
            <span id="generateFileLabel" className="muted generateFileLabel">{path ? path.split("/").pop() : "未选择文件"}</span>
            <span className="headActions" style={{ marginLeft: "auto" }}>
              <button type="button" id="generateCommitBtn" className={`btn btnXs primary${importing ? " btnRunning" : ""}`} disabled={importing || !!generatingId} onClick={() => void commit()}>{importing ? "导入中…" : "导入"}</button>
            </span>
          </div>
          <div className="uploadSelectLayout generateLayout generateModalLayout">
            <aside className="generateTreeCol">
              <div className="stripHead"><span>文件</span></div>
              <div id="generateFileTree" className="fileTree scrollInner">{renderFileTreeNodes(tree, path, (n) => { if (n.path) void loadDocumentText(n.path); }, true)}</div>
            </aside>
            <aside className="uploadSelectLeft">
              <div className="uploadPhaseHead stripHead">
                <span className="uploadPhaseTitle">选择行范围</span>
                <button type="button" id="generateAddSelectionBtn" className="btn btnXs primary" disabled={importing || !!generatingId} onClick={addSelection}>添加选择</button>
              </div>
              <div className="rangeRow">
                <input type="number" id="generateSelLineStart" value={lineStart} min={1} onChange={(e) => setLineStart(parseInt(e.target.value, 10))} />
                <span>–</span>
                <input type="number" id="generateSelLineEnd" value={lineEnd} min={1} onChange={(e) => setLineEnd(parseInt(e.target.value, 10))} />
              </div>
              <div id="generateSelectionsList" className="uploadSelectionsList">
                {selections.map((s) => (
                  <div key={s.id} className={`uploadSelectionCard${activeSelectionId === s.id ? " active" : ""}`}>
                    <div className="uploadSelectionHead">
                      <span className="uploadSelectionTitle">第 {s.lineStart}–{s.lineEnd} 行</span>
                      <span className="uploadSelectionActions">
                        <button type="button" className="btn btnXs ghost" onClick={() => setActiveSelectionId(s.id)} disabled={!!generatingId || importing}>高亮</button>
                        <button type="button" className={`btn btnXs primary${generatingId === s.id ? " btnRunning" : ""}`} disabled={!!generatingId || importing} onClick={() => void autoGenerate(s)}>{generatingId === s.id ? "生成中…" : "自动生成问法"}</button>
                        <button type="button" className="btn btnXs ghost" onClick={() => removeSelection(s.id)} disabled={!!generatingId || importing}>删除</button>
                      </span>
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
