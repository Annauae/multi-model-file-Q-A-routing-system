import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson, streamDocumentExtract } from "../api/client";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { TimingsPanel, TokenPanel } from "../components/MetricsPanels";
import { Dropdown } from "../components/Dropdown";
import { useAppUi } from "../context/AppUiContext";
import type { AskTimings, FileTreeNode, ImportSelection } from "../types";
import { MdLineViewer, renderFileTreeNodes, sliceMarkdownLines } from "../utils/importShared";
import { useKnowledgeBases } from "../hooks/useKnowledgeBases";

export function ManageFilesView() {
  const { showToast } = useAppUi();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [selected, setSelected] = useState<{ path: string; kind: string; name: string } | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [loadedContent, setLoadedContent] = useState("");
  const [editMode, setEditMode] = useState<"source" | "preview">("source");
  const [extractOpen, setExtractOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [pdfRanges, setPdfRanges] = useState([{ start: 1, end: 5 }]);
  const [extractLog, setExtractLog] = useState("");
  const [extractMetrics, setExtractMetrics] = useState<AskTimings | null>(null);

  const loadTree = useCallback(async () => {
    const data = await apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree");
    setTree(data.tree || []);
  }, []);

  useEffect(() => { void loadTree(); }, [loadTree]);

  const selectFile = async (node: FileTreeNode) => {
    if (selected?.path !== node.path && markdown !== loadedContent && selected?.kind !== "source_pdf") {
      if (!confirm("当前 Markdown 有未保存修改，切换文件将丢失。是否继续？")) return;
    }
    setSelected({ path: node.path, kind: node.kind, name: node.name });
    if (node.kind === "source_pdf") return;
    const data = await apiJson<{ markdown: string }>(`/markdown-files/content?path=${encodeURIComponent(node.path)}`);
    setMarkdown(data.markdown || "");
    setLoadedContent(data.markdown || "");
    setEditMode("source");
  };

  const saveMd = async () => {
    if (!selected || selected.kind === "source_pdf") return showToast("请选择 Markdown", "error");
    await apiJson("/markdown-files/content", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: selected.path, markdown }) });
    setLoadedContent(markdown);
    showToast("已保存");
  };

  const uploadFile = async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    await fetch("/documents/upload", { method: "POST", body: fd });
    await loadTree();
    showToast("上传成功");
  };

  const runExtract = async () => {
    if (!selected?.path) return;
    setExtractLog("");
    await streamDocumentExtract(
      { path: selected.path, ranges: pdfRanges.map((r) => [Math.max(1, r.start), Math.max(r.start, r.end)]) },
      (evt) => {
        if (evt.event === "log") setExtractLog((p) => p + String(evt.data.message || evt.data.detail || "") + "\n");
        if (evt.event === "done") {
          const d = evt.data as { markdown?: string; path?: string; timings?: AskTimings };
          if (d.markdown) { setMarkdown(d.markdown); setLoadedContent(d.markdown); }
          if (d.path) setSelected({ path: d.path, kind: "module_md", name: d.path.split("/").pop() || "" });
          setExtractMetrics(d.timings || null);
          setExtractOpen(false);
          void loadTree();
        }
        if (evt.event === "error") showToast(String(evt.data.detail || "错误"), "error");
      },
    );
  };

  const isPdf = selected?.kind === "source_pdf";
  const lineCount = markdown ? markdown.split("\n").length : 0;

  return (
    <div className="filesPage panel">
      <div className="stripHead">
        <span id="filesSelectedLabel" className={`${selected ? "" : "muted "}filesSelectedLabel`}>
          {selected ? `${isPdf ? "PDF" : "Markdown"}：${selected.name}` : "未选择文件"}
        </span>
        <span className="headActions">
          <button type="button" id="filesToolbarUpload" className="btn btnXs primary" onClick={() => fileInputRef.current?.click()}>上传文件</button>
          <button type="button" id="filesToolbarExtract" className="btn btnXs" disabled={!isPdf} onClick={() => setExtractOpen(true)}>文件转 Markdown</button>
          <button type="button" id="filesToolbarGenerate" className="btn btnXs" disabled={isPdf || !selected} onClick={() => setGenerateOpen(true)}>问题生成</button>
          <button type="button" id="filesToolbarRefresh" className="btn btnXs ghost" onClick={() => void loadTree()}>刷新</button>
          <button type="button" id="filesMainSaveBtn" className="btn btnXs primary" disabled={isPdf || !selected} onClick={() => void saveMd()}>保存</button>
          <Dropdown label="操作" primary={false}>
            <button type="button" className="dropdownItem" data-files-action="newMd" onClick={async () => {
              const name = prompt("新建 Markdown 文件名（不含路径）", "new.md");
              if (!name?.trim()) return;
              const path = name.includes("/") ? name : `modules/${name}`;
              await apiJson("/markdown-files/content", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, markdown: "" }) });
              await loadTree();
              setSelected({ path, kind: "module_md", name: path.split("/").pop() || name });
              setMarkdown("");
              setLoadedContent("");
            }}>新建 MD</button>
            <button type="button" className="dropdownItem" data-files-action="rename" disabled={!selected} onClick={async () => {
              if (!selected) return;
              const newName = prompt("新文件名", selected.name);
              if (!newName?.trim()) return;
              await apiJson("/markdown-files/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: selected.path, new_name: newName }) });
              await loadTree();
              showToast("已重命名");
            }}>重命名</button>
            <div className="dropdownDivider" />
            <button type="button" className="dropdownItem danger" data-files-action="delete" disabled={!selected} onClick={async () => {
              if (!selected || !confirm(`确定删除 ${selected.name}？`)) return;
              await apiJson("/markdown-files/content", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: selected.path }) });
              setSelected(null);
              setMarkdown("");
              await loadTree();
              showToast("已删除");
            }}>删除</button>
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
            <span className="uploadPhaseTitle" id="filesEditorTitle">Markdown 编辑</span>
            <span id="filesEditLineCountLabel" className="muted">{lineCount ? `${lineCount} 行` : ""}</span>
            <div className="segmentedControl" id="filesEditSegment">
              <button type="button" className={`segmentedBtn ${editMode === "source" ? "active" : ""}`} id="filesEditTabSource" onClick={() => setEditMode("source")}>编辑</button>
              <button type="button" className={`segmentedBtn ${editMode === "preview" ? "active" : ""}`} id="filesEditTabPreview" onClick={() => setEditMode("preview")}>预览</button>
            </div>
          </div>
          <div id="filesPdfHint" className={`filesPdfHint${isPdf ? "" : " hidden"} muted`}>已选 PDF，请点击「文件转 Markdown」将其转为 Markdown</div>
          <div className="uploadEditBody filesEditBody">
            <div id="filesEditSourcePane" className={`uploadEditPane${editMode === "source" && !isPdf && selected ? " active" : ""}`}>
              {!isPdf && selected && (
                <textarea id="filesEditSource" className="uploadEditTextarea" spellCheck={false} placeholder="从左侧选择文件…" value={markdown} onChange={(e) => setMarkdown(e.target.value)} />
              )}
            </div>
            <div id="filesEditPreviewPane" className={`uploadEditPane answerPreviewBox mdPreview${editMode === "preview" && !isPdf && selected ? " active" : ""}`}>
              {!isPdf && selected && editMode === "preview" && <MarkdownPreview md={markdown} kbId="documents" />}
            </div>
          </div>
        </section>
      </div>
      <input ref={fileInputRef} id="filesFileInput" type="file" accept=".pdf,.md,.markdown" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />

      {extractOpen && (
        <div className="modalOverlay" id="extractModalOverlay">
          <div className="modal modalWide">
            <div className="modalHead">
              <span>文件转 Markdown</span>
              <button type="button" id="extractModalCloseBtn" className="btn btnXs ghost" onClick={() => setExtractOpen(false)}>关闭</button>
            </div>
            <div className="modalBody">
              <p id="extractModalFileLabel" className="muted">{selected ? selected.name : "未选择 PDF"}</p>
              <div id="filesPdfRange" className="uploadRangeBlock">
                <div className="uploadRangeHead filesPdfRangeHead">
                  <span className="uploadRangeTitle">PDF 页码范围</span>
                  <button type="button" id="filesAddPdfRangeBtn" className="btn btnXs ghost" onClick={() => setPdfRanges([...pdfRanges, { start: pdfRanges[pdfRanges.length - 1].end + 1, end: pdfRanges[pdfRanges.length - 1].end + 3 }])}>+ 添加范围</button>
                </div>
                <div id="filesPdfRangeList" className="rangeList">
                  {pdfRanges.map((r, i) => (
                    <div key={i} className="rangeRow">
                      <span>从</span>
                      <input type="number" className="filesPdfRangeStart" value={r.start} min={1} onChange={(e) => { const n = [...pdfRanges]; n[i].start = parseInt(e.target.value, 10); setPdfRanges(n); }} />
                      <span>到</span>
                      <input type="number" className="filesPdfRangeEnd" value={r.end} min={1} onChange={(e) => { const n = [...pdfRanges]; n[i].end = parseInt(e.target.value, 10); setPdfRanges(n); }} />
                      {pdfRanges.length > 1 && <button type="button" className="btn btnXs ghost" onClick={() => setPdfRanges(pdfRanges.filter((_, j) => j !== i))}>删除</button>}
                    </div>
                  ))}
                </div>
              </div>
              <button type="button" id="filesExtractBtn" className="btn btnXs primary" style={{ width: "100%", marginTop: 12 }} onClick={() => void runExtract()}>开始提取</button>
              {extractLog && <div id="filesProgress" className="importProgress importProgressModal">{extractLog}</div>}
              <div className="workflowMetrics">
                <div className="workflowMetricsHead muted">消耗时间</div>
                <div id="extractModalTimingPanel" className="timingPanel"><TimingsPanel timings={extractMetrics} emptyText="提取完成后显示" mode="import" /></div>
                <div className="workflowMetricsHead muted">消耗 Token</div>
                <div id="extractModalTokenPanel" className="tokenPanel"><TokenPanel timings={extractMetrics} emptyText="提取完成后显示" /></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {generateOpen && <GenerateModal open onClose={() => setGenerateOpen(false)} initialPath={selected?.kind !== "source_pdf" ? selected?.path : ""} initialMarkdown={markdown} onCommitted={() => void loadTree()} />}
    </div>
  );
}

function GenerateModal({ open, onClose, initialPath, initialMarkdown, onCommitted }: {
  open: boolean; onClose: () => void; initialPath?: string; initialMarkdown?: string; onCommitted: () => void;
}) {
  const { showToast } = useAppUi();
  const { kbMap } = useKnowledgeBases();
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [kbId, setKbId] = useState("");
  const [path, setPath] = useState(initialPath || "");
  const [md, setMd] = useState(initialMarkdown || "");
  const [lineStart, setLineStart] = useState(1);
  const [lineEnd, setLineEnd] = useState(10);
  const [selections, setSelections] = useState<ImportSelection[]>([]);
  const [metrics, setMetrics] = useState<AskTimings | null>(null);
  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));

  useEffect(() => {
    if (!open) return;
    void apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree").then((d) => setTree(d.tree || []));
    if (!kbId && kbIds.length) setKbId(kbIds[0]);
    if (initialPath && initialMarkdown) { setPath(initialPath); setMd(initialMarkdown); }
  }, [open, initialPath, initialMarkdown]);

  const loadMd = async (p: string) => {
    const data = await apiJson<{ markdown: string }>(`/markdown-files/content?path=${encodeURIComponent(p)}`);
    setMd(data.markdown || "");
    setPath(p);
    setLineEnd(Math.min(10, (data.markdown || "").split("\n").length));
  };

  const addSelection = () => {
    const answer = sliceMarkdownLines(md, lineStart, lineEnd);
    setSelections([...selections, { id: `s_${Date.now()}`, lineStart, lineEnd, question: "", variants: [], answer }]);
  };

  const autoGenerate = async (sel: ImportSelection) => {
    const t0 = performance.now();
    const data = await apiJson<{ question: string; variants: string[] }>(`/knowledge-bases/${encodeURIComponent(kbId)}/import/generate-questions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer_md: sel.answer }),
    });
    sel.question = data.question;
    sel.variants = data.variants || [];
    setSelections([...selections]);
    setMetrics({ total_ms: performance.now() - t0 });
  };

  const commit = async () => {
    if (!kbId) return showToast("请选择知识库", "error");
    const items = selections.filter((s) => s.question.trim());
    if (!items.length) return showToast("请至少添加一条有效选择", "error");
    await apiJson(`/knowledge-bases/${encodeURIComponent(kbId)}/import/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items.map((s) => ({ question: s.question, variants: s.variants, answer: s.answer, enabled: true })), append: true }),
    });
    showToast(`已导入 ${items.length} 条`);
    onCommitted();
    onClose();
  };

  if (!open) return null;

  return (
    <div className="modalOverlay" id="generateModalOverlay">
      <div className="modal modalWide modalTall">
        <div className="modalHead">
          <span>问题生成</span>
          <button type="button" id="generateModalCloseBtn" className="btn btnXs ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="modalBody generateModalBody">
          <div className="generateToolbar stripHead" style={{ border: "none", padding: "0 0 10px" }}>
            <label className="kbSelectLabel">导入知识库<select id="generateKbSelect" className="kbSelect" value={kbId} onChange={(e) => setKbId(e.target.value)}>{kbIds.map((id) => <option key={id} value={id}>{kbMap[id]?.name || id}</option>)}</select></label>
            <button type="button" id="generateRefreshTreeBtn" className="btn btnXs ghost" onClick={() => void apiJson<{ tree: FileTreeNode[] }>("/markdown-files/tree").then((d) => setTree(d.tree || []))}>刷新文件</button>
            <span id="generateFileLabel" className="muted generateFileLabel">{path ? path.split("/").pop() : "未选择 Markdown"}</span>
            <span className="headActions" style={{ marginLeft: "auto" }}>
              <button type="button" id="generateCommitBtn" className="btn btnXs primary" onClick={() => void commit()}>导入到知识库</button>
            </span>
          </div>
          <div className="uploadSelectLayout generateLayout generateModalLayout">
            <aside className="generateTreeCol">
              <div className="stripHead"><span>Markdown 文件</span></div>
              <div id="generateFileTree" className="fileTree scrollInner">{renderFileTreeNodes(tree, path, (n) => { if (n.kind !== "source_pdf") void loadMd(n.path); }, true)}</div>
            </aside>
            <aside className="uploadSelectLeft">
              <div className="uploadPhaseHead stripHead">
                <span className="uploadPhaseTitle">选择行范围</span>
                <button type="button" id="generateAddSelectionBtn" className="btn btnXs primary" onClick={addSelection}>添加选择</button>
              </div>
              <div className="rangeRow">
                <input type="number" id="generateSelLineStart" value={lineStart} min={1} onChange={(e) => setLineStart(parseInt(e.target.value, 10))} />
                <span>–</span>
                <input type="number" id="generateSelLineEnd" value={lineEnd} min={1} onChange={(e) => setLineEnd(parseInt(e.target.value, 10))} />
              </div>
              <div id="generateSelectionsList">
                {selections.map((s) => (
                  <div key={s.id} className="uploadSelectionCard">
                    <div className="muted">行 {s.lineStart}–{s.lineEnd}</div>
                    <input className="importSelQuestion" value={s.question} placeholder="标准问题" onChange={(e) => { s.question = e.target.value; setSelections([...selections]); }} />
                    <textarea className="importSelVariants" rows={2} value={(s.variants || []).join("\n")} placeholder="其他问法" onChange={(e) => { s.variants = e.target.value.split("\n").filter(Boolean); setSelections([...selections]); }} />
                    <button type="button" className="btn btnXs ghost" onClick={() => void autoGenerate(s)}>自动生成问法</button>
                  </div>
                ))}
              </div>
              {metrics && (
                <div className="workflowMetrics">
                  <div id="generateModalTimingPanel" className="timingPanel"><TimingsPanel timings={metrics} mode="import" /></div>
                </div>
              )}
            </aside>
            <section className="uploadSelectRight">
              <div id="generateMdViewer" className="scrollInner"><MdLineViewer markdown={md} lineStart={lineStart} lineEnd={lineEnd} selections={selections} /></div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
