import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson, formatQuestionId, parseQuestionNum } from "../api/client";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { BatchAddItemsForm, parseBatchAddRows, type BatchAddRow } from "../components/BatchAddItemsForm";
import { useAppUi } from "../context/AppUiContext";
import { useKnowledgeBases, useRagKnowledgeBases } from "../hooks/useKnowledgeBases";
import type { QAItem, QuestionsDocument } from "../types";
import { Dropdown } from "../components/Dropdown";
import { ManageFilesView } from "./ManageFilesView";
import { ModeBar } from "../components/ModeBar";
import { IndexStatusPill } from "../components/IndexStatusPill";
import type { AskMode } from "../types";

export function ManageView({ sub, onSubChange }: { sub: "items" | "files"; onSubChange: (s: "items" | "files") => void }) {
  return (
    <section className="viewPane active" id="viewManage">
      <div className="managePageLayout">
        <nav className="manageSubNav" id="manageSubNav">
          <button type="button" className={`manageNavItem ${sub === "items" ? "active" : ""}`} data-manage-sub="items" onClick={() => onSubChange("items")}>问题管理</button>
          <button type="button" className={`manageNavItem ${sub === "files" ? "active" : ""}`} data-manage-sub="files" onClick={() => onSubChange("files")}>文件管理</button>
        </nav>
        <div className="manageMain">
          <div id="manageSubPaneItems" className={`manageSubPane ${sub === "items" ? "active" : ""}`}>
            {sub === "items" && <ManageQuestionsView />}
          </div>
          <div id="manageSubPaneFiles" className={`manageSubPane ${sub === "files" ? "active" : ""}`}>
            {sub === "files" && <ManageFilesView />}
          </div>
        </div>
      </div>
    </section>
  );
}

function ManageQuestionsView() {
  const { showToast, showModal } = useAppUi();
  const llmKb = useKnowledgeBases();
  const ragKb = useRagKnowledgeBases();
  const [manageMode, setManageMode] = useState<AskMode>("llm");
  const [selectedKbId, setSelectedKbId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [doc, setDoc] = useState<QuestionsDocument>({ version: 1, items: [] });
  const [editItem, setEditItem] = useState<QAItem | null>(null);
  const [editorTab, setEditorTab] = useState<"item" | "json">("item");
  const [jsonText, setJsonText] = useState("");
  const batchRowsRef = useRef<BatchAddRow[]>([]);

  const isRag = manageMode === "rag";
  const kbMap = isRag ? ragKb.kbMap : llmKb.kbMap;
  const kbDisplayName = isRag ? ragKb.kbDisplayName : llmKb.kbDisplayName;
  const refreshKbList = isRag ? ragKb.refresh : llmKb.refresh;

  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));
  const kbPrefix = isRag ? "rag_kb" : "kb";

  const questionsBase = isRag
    ? (kid: string) => `/rag/knowledge-bases/${encodeURIComponent(kid)}/questions`
    : (kid: string) => `/knowledge-bases/${encodeURIComponent(kid)}/questions`;

  const kbApiBase = isRag ? "/rag/knowledge-bases" : "/knowledge-bases";

  const loadItems = useCallback(async (kid: string) => {
    if (!kid) return;
    const data = await apiJson<QuestionsDocument>(questionsBase(kid));
    setDoc(data);
  }, [isRag]);

  useEffect(() => {
    if (!kbIds.length) {
      setSelectedKbId("");
      return;
    }
    if (!selectedKbId || !kbIds.includes(selectedKbId))
      setSelectedKbId(kbIds[0]);
  }, [kbIds, selectedKbId, manageMode]);

  useEffect(() => {
    if (selectedKbId) void loadItems(selectedKbId);
  }, [selectedKbId, loadItems]);

  const visible = (doc.items || []).filter((it) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [it.id, it.question, ...(it.variants || [])].join(" ").toLowerCase().includes(q);
  });

  const openEdit = (item: QAItem) => {
    setSelectedItemId(item.id);
    setEditItem({ ...item });
    setJsonText(JSON.stringify(item, null, 2));
    setEditorTab("item");
    setAnswerTab("edit");
  };

  const closeEdit = () => {
    setEditItem(null);
    setSelectedItemId("");
  };

  const saveEditor = async () => {
    if (!selectedKbId || !editItem) return;
    let payload: QAItem;
    if (editorTab === "json") {
      payload = JSON.parse(jsonText);
      if (!payload?.id) throw new Error("JSON 须包含 id 字段");
    } else {
      payload = editItem;
      if (!payload.question) return showToast("标准问题不能为空", "error");
    }
    const exists = (doc.items || []).some((x) => x.id === payload.id);
    const base = questionsBase(selectedKbId);
    const url = `${base}/items${exists ? `/${encodeURIComponent(payload.id)}` : ""}`;
    await apiJson(url, { method: exists ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!isRag) await llmKb.refresh();
    else await ragKb.refresh();
    await loadItems(selectedKbId);
    setSelectedItemId(payload.id);
    closeEdit();
    showToast("保存成功");
  };

  const allocateId = (occupied = new Set<string>()) => {
    let max = 0;
    for (const it of doc.items || []) {
      max = Math.max(max, parseQuestionNum(it.id));
      occupied.add(it.id);
    }
    let n = max + 1;
    while (occupied.has(formatQuestionId(n))) n += 1;
    return formatQuestionId(n);
  };

  const handleKbAction = async (action: string) => {
    if (action === "add") {
      showModal("新增知识库", <label className="fieldLabel">名称<input id="modalKbName" type="text" placeholder="知识库名称" /></label>, async () => {
        const el = document.getElementById("modalKbName") as HTMLInputElement;
        const name = el?.value.trim();
        if (!name) throw new Error("名称不能为空");
        const data = await apiJson<{ kb_id: string }>(kbApiBase, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
        await refreshKbList();
        setSelectedKbId(data.kb_id);
        showToast("知识库已创建");
      });
    } else if (action === "rename" && selectedKbId) {
      showModal("重命名知识库", <label className="fieldLabel">名称<input id="modalKbRename" type="text" defaultValue={kbDisplayName(selectedKbId)} /></label>, async () => {
        const el = document.getElementById("modalKbRename") as HTMLInputElement;
        await apiJson(`${kbApiBase}/${encodeURIComponent(selectedKbId)}/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: el.value.trim() }) });
        await refreshKbList();
        showToast("重命名成功");
      });
    } else if (action === "reload" && selectedKbId && !isRag) {
      const data = await apiJson<{ enabled_count?: number }>(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/reload`, { method: "POST" });
      await llmKb.refresh();
      showToast(`索引已重载（${data.enabled_count ?? 0} 题启用）`);
    } else if (action === "importFromRag" && selectedKbId && !isRag) {
      const ragIds = Object.keys(ragKb.kbMap);
      showModal(
        "从 RAG 导入 FAQ",
        <div>
          <p className="muted">将所选 RAG 知识库的 FAQ 复制到当前问答模型知识库，并重新加载索引。</p>
          <label className="fieldLabel">来源 RAG 知识库
            <select id="importFromRagSelect" className="settingsInput" defaultValue={ragIds[0] || ""}>
              {ragIds.map((id) => <option key={id} value={id}>{ragKb.kbDisplayName(id)} (rag_kb_{id})</option>)}
            </select>
          </label>
        </div>,
        async () => {
          const ragKid = (document.getElementById("importFromRagSelect") as HTMLSelectElement)?.value;
          if (!ragKid) throw new Error("请选择来源知识库");
          const data = await apiJson<{ imported: number }>(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/import/from-rag`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rag_kb_id: ragKid, append: false, replace: true }),
          });
          await llmKb.refresh();
          await loadItems(selectedKbId);
          showToast(`已导入 ${data.imported} 条并重载索引`);
        },
        true,
      );
    } else if (action === "importFromLlm" && selectedKbId && isRag) {
      const llmIds = Object.keys(llmKb.kbMap);
      showModal(
        "从问答模型导入 FAQ",
        <div>
          <p className="muted">将所选问答模型知识库的 FAQ 复制到当前 RAG 知识库，并可选重建向量索引。</p>
          <label className="fieldLabel">来源（问答模型）知识库
            <select id="importFromLlmSelect" className="settingsInput" defaultValue={llmIds[0] || ""}>
              {llmIds.map((id) => <option key={id} value={id}>{llmKb.kbDisplayName(id)} (kb_{id})</option>)}
            </select>
          </label>
        </div>,
        async () => {
          const llmKid = (document.getElementById("importFromLlmSelect") as HTMLSelectElement)?.value;
          if (!llmKid) throw new Error("请选择来源知识库");
          const data = await apiJson<{ imported: number }>(`/rag/knowledge-bases/${encodeURIComponent(selectedKbId)}/import/from-llm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ llm_kb_id: llmKid, append: false, auto_rebuild: true }),
          });
          await ragKb.refresh();
          await loadItems(selectedKbId);
          showToast(`已导入 ${data.imported} 条并重建索引`);
        },
        true,
      );
    } else if (action === "delete" && selectedKbId) {
      if (!confirm(`确定删除知识库「${kbDisplayName(selectedKbId)}」？此操作不可恢复。`)) return;
      await apiJson(`${kbApiBase}/${encodeURIComponent(selectedKbId)}`, { method: "DELETE" });
      await refreshKbList();
      setSelectedKbId(kbIds.find((id) => id !== selectedKbId) || "");
      showToast("知识库已删除");
    } else if (action === "refresh") {
      await refreshKbList();
      showToast("刷新成功");
    }
  };

  const handleItemAction = async (action: string) => {
    if (!selectedKbId && action !== "refresh") return showToast("请先选择知识库", "error");
    if (action === "add") {
      openEdit({ id: allocateId(), question: "", variants: [], answer: "", enabled: true });
    } else if (action === "batchAdd") {
      batchRowsRef.current = [];
      showModal(
        "批量新增标准问题",
        <BatchAddItemsForm onChange={(rows) => { batchRowsRef.current = rows; }} />,
        async () => {
          const parsed = parseBatchAddRows(batchRowsRef.current);
          const occupied = new Set((doc.items || []).map((x) => x.id));
          let count = 0;
          for (const row of parsed) {
            if (!row.question) throw new Error("标准问题不能为空");
            if (!row.answer) throw new Error("回答不能为空");
            const id = allocateId(occupied);
            occupied.add(id);
            await apiJson(`${questionsBase(selectedKbId)}/items`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, question: row.question, variants: row.variants, answer: row.answer, enabled: true }),
            });
            count += 1;
          }
          if (!count) throw new Error("请至少填写一组问题");
          await refreshKbList();
          await loadItems(selectedKbId);
          showToast(`已新增 ${count} 条`);
        },
        true,
      );
    } else if (action === "refresh") {
      await loadItems(selectedKbId);
      showToast("刷新成功");
    } else if (action === "selectAll") {
      setCheckedIds(new Set(visible.map((it) => it.id)));
    } else if (action === "selectNone") {
      setCheckedIds(new Set());
    } else if (action === "invertSelect") {
      const next = new Set<string>();
      visible.forEach((it) => { if (!checkedIds.has(it.id)) next.add(it.id); });
      setCheckedIds(next);
    } else if (action === "enableSelected" || action === "disableSelected") {
      if (!checkedIds.size) return showToast("请先勾选条目", "error");
      const enabled = action === "enableSelected";
      for (const id of checkedIds) {
        const item = (doc.items || []).find((x) => x.id === id);
        if (!item) continue;
        await apiJson(`${questionsBase(selectedKbId)}/items/${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...item, enabled }),
        });
      }
      await refreshKbList();
      await loadItems(selectedKbId);
      showToast(enabled ? "已启用选中" : "已禁用选中");
    } else if (action === "deleteSelected") {
      if (!checkedIds.size) return showToast("请先勾选条目", "error");
      if (!confirm(`确定删除选中的 ${checkedIds.size} 条？`)) return;
      for (const id of checkedIds) {
        await apiJson(`${questionsBase(selectedKbId)}/items/${encodeURIComponent(id)}`, { method: "DELETE" });
      }
      setCheckedIds(new Set());
      await refreshKbList();
      await loadItems(selectedKbId);
      showToast("已删除");
    }
  };

  return (
    <div className="manageLayout manageLayoutItems">
      <section className="manageCol manageKbCol">
        <div className="stripHead">
          <span>{isRag ? "RAG 知识库" : "知识库"}</span>
          <span className="headActions">
            <Dropdown label="操作">
              <button type="button" className="dropdownItem" onClick={() => void handleKbAction("add")}>新增知识库</button>
              <button type="button" className="dropdownItem" onClick={() => void handleKbAction("refresh")}>刷新列表</button>
              <div className="dropdownDivider" />
              <button type="button" className="dropdownItem" onClick={() => void handleKbAction("rename")}>重命名</button>
              {isRag ? (
                <button type="button" className="dropdownItem" onClick={() => void handleKbAction("importFromLlm")}>从问答模型导入 FAQ</button>
              ) : (
                <>
                  <button type="button" className="dropdownItem" onClick={() => void handleKbAction("importFromRag")}>从 RAG 导入 FAQ</button>
                  <button type="button" className="dropdownItem" onClick={() => void handleKbAction("reload")}>重新加载索引</button>
                </>
              )}
              <div className="dropdownDivider" />
              <button type="button" className="dropdownItem danger" onClick={() => void handleKbAction("delete")}>删除知识库</button>
            </Dropdown>
          </span>
        </div>
        <div id="kbList" className="scrollInner listBody">
          {kbIds.length ? kbIds.map((id) => (
            <div key={id} className={`listItem ${id === selectedKbId ? "active" : ""}`} onClick={() => { setSelectedKbId(id); setCheckedIds(new Set()); }}>
              <div className="listItemContent">
                <div>{kbDisplayName(id)}</div>
                <div className="sub">{kbPrefix}_{id} · {kbMap[id]?.enabled_count ?? 0} 题</div>
              </div>
            </div>
          )) : <div className="empty">暂无知识库</div>}
        </div>
      </section>

      <section className="manageCol manageItemsMain">
        <ModeBar label="FAQ 模式" mode={manageMode} onChange={(m) => { setManageMode(m); setEditItem(null); setCheckedIds(new Set()); setSelectedKbId(""); }} />
        <div className="stripHead manageItemsHead">
          <span>{isRag ? "RAG 标准问题" : "标准问题"}</span>
          <span className="headActions manageItemsHeadActions">
            {isRag && selectedKbId && <IndexStatusPill kbId={selectedKbId} onRebuild={() => { void loadItems(selectedKbId); void ragKb.refresh(); }} />}
            <input id="itemSearch" type="search" className="itemSearchInput" placeholder="搜索问题…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Dropdown label="操作">
              <button type="button" className="dropdownItem" onClick={() => void handleItemAction("add")}>新增问题</button>
              <button type="button" className="dropdownItem" onClick={() => void handleItemAction("batchAdd")}>批量新增</button>
              <button type="button" className="dropdownItem" onClick={() => void handleItemAction("refresh")}>刷新列表</button>
              <div className="dropdownDivider" />
              <button type="button" className="dropdownItem" onClick={() => void handleItemAction("selectAll")}>全选</button>
              <button type="button" className="dropdownItem" onClick={() => void handleItemAction("selectNone")}>取消全选</button>
              <button type="button" className="dropdownItem" onClick={() => void handleItemAction("invertSelect")}>反选</button>
              <div className="dropdownDivider" />
              <button type="button" className="dropdownItem" onClick={() => void handleItemAction("enableSelected")}>启用选中</button>
              <button type="button" className="dropdownItem" onClick={() => void handleItemAction("disableSelected")}>禁用选中</button>
              <button type="button" className="dropdownItem danger" onClick={() => void handleItemAction("deleteSelected")}>删除选中</button>
            </Dropdown>
          </span>
        </div>
        <div id="itemList" className="scrollInner itemCardGrid">
          {!selectedKbId ? <div className="empty">请选择知识库</div> : visible.length ? visible.map((it) => (
            <div key={it.id} className={`itemCard${it.enabled === false ? " disabled" : ""}${it.id === selectedItemId ? " active" : ""}`} onClick={() => openEdit(it)}>
              <label className="itemCardCheck" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={checkedIds.has(it.id)} onChange={(e) => {
                  const s = new Set(checkedIds);
                  if (e.target.checked) s.add(it.id); else s.delete(it.id);
                  setCheckedIds(s);
                }} />
              </label>
              <span className="itemCardId">{it.id}</span>
              <div className="itemCardQuestion">{it.question}{it.enabled === false && <span className="itemCardDisabledTag">已禁用</span>}</div>
            </div>
          )) : <div className="empty">无条目</div>}
        </div>
      </section>

      <div id="itemEditOverlay" className={`modalOverlay${editItem ? "" : " hidden"}`}>
        <div className="modal modalWide modalTall">
          <div className="modalHead">
            <span>编辑标准问题</span>
            <button type="button" className="btn btnXs ghost" onClick={closeEdit}>返回</button>
          </div>
          <div className="modalBody itemEditBody">
            <div className="stripHead editorTabHead" style={{ border: "none", padding: "0 0 10px" }}>
              <div className="leftTabs">
                <button type="button" className={`tabBtn ${editorTab === "item" ? "active" : ""}`} onClick={() => setEditorTab("item")}>问题编辑</button>
                <button type="button" className={`tabBtn ${editorTab === "json" ? "active" : ""}`} onClick={() => { setJsonText(JSON.stringify(editItem, null, 2)); setEditorTab("json"); }}>JSON 源码</button>
              </div>
            </div>
            <div className="editorBody">
              <div className={`editorPane ${editorTab === "item" ? "active" : ""}`}>
                <label className="fieldLabel">ID<input type="text" readOnly value={editItem?.id || ""} /></label>
                <label className="fieldLabel">标准问题<textarea rows={2} value={editItem?.question || ""} onChange={(e) => editItem && setEditItem({ ...editItem, question: e.target.value })} /></label>
                <label className="fieldLabel">其他问法（每行一条）<textarea rows={3} value={(editItem?.variants || []).join("\n")} onChange={(e) => editItem && setEditItem({ ...editItem, variants: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} /></label>
                <label className="fieldLabel">回答（Markdown）</label>
                {editItem && (
                  <MarkdownEditor
                    value={editItem.answer || ""}
                    onChange={(answer) => setEditItem({ ...editItem, answer })}
                    kbId={selectedKbId}
                    minHeight={320}
                  />
                )}
                <label className="fieldCheck"><input type="checkbox" checked={editItem?.enabled !== false} onChange={(e) => editItem && setEditItem({ ...editItem, enabled: e.target.checked })} /> 启用匹配</label>
              </div>
              <div className={`editorPane ${editorTab === "json" ? "active" : ""}`}>
                <textarea className="jsonEditor" spellCheck={false} rows={16} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="modalFoot">
            <button type="button" className="btn primary btnXs" onClick={() => void saveEditor().catch((e) => showToast(e.message, "error"))}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}
