import { useCallback, useEffect, useState } from "react";
import { apiJson, formatQuestionId, parseQuestionNum } from "../api/client";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { useAppUi } from "../context/AppUiContext";
import { useKnowledgeBases } from "../hooks/useKnowledgeBases";
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
  const { kbMap, refresh: refreshKb, kbDisplayName } = useKnowledgeBases();
  const [manageMode, setManageMode] = useState<AskMode>("llm");
  const [selectedKbId, setSelectedKbId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [doc, setDoc] = useState<QuestionsDocument>({ version: 1, items: [] });
  const [editItem, setEditItem] = useState<QAItem | null>(null);
  const [editorTab, setEditorTab] = useState<"item" | "json">("item");
  const [jsonText, setJsonText] = useState("");
  const [answerTab, setAnswerTab] = useState<"edit" | "preview">("edit");

  const kbIds = Object.keys(kbMap).sort((a, b) => Number(a) - Number(b));

  const questionsBase = manageMode === "rag"
    ? (kid: string) => `/rag/knowledge-bases/${encodeURIComponent(kid)}/questions`
    : (kid: string) => `/knowledge-bases/${encodeURIComponent(kid)}/questions`;

  const loadItems = useCallback(async (kid: string) => {
    if (!kid) return;
    const data = await apiJson<QuestionsDocument>(questionsBase(kid));
    setDoc(data);
  }, [manageMode]);

  useEffect(() => {
    if (!selectedKbId && kbIds.length) setSelectedKbId(kbIds[0]);
  }, [kbIds, selectedKbId]);

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
    if (manageMode === "llm") await refreshKb();
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
        const data = await apiJson<{ kb_id: string }>("/knowledge-bases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
        await refreshKb();
        setSelectedKbId(data.kb_id);
        showToast("知识库已创建");
      });
    } else if (action === "rename" && selectedKbId) {
      showModal("重命名知识库", <label className="fieldLabel">名称<input id="modalKbRename" type="text" defaultValue={kbDisplayName(selectedKbId)} /></label>, async () => {
        const el = document.getElementById("modalKbRename") as HTMLInputElement;
        await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: el.value.trim() }) });
        await refreshKb();
        showToast("重命名成功");
      });
    } else if (action === "reload" && selectedKbId) {
      const data = await apiJson<{ enabled_count?: number }>(`/knowledge-bases/${encodeURIComponent(selectedKbId)}/reload`, { method: "POST" });
      await refreshKb();
      showToast(`索引已重载（${data.enabled_count ?? 0} 题启用）`);
    } else if (action === "delete" && selectedKbId) {
      if (!confirm(`确定删除知识库「${kbDisplayName(selectedKbId)}」？此操作不可恢复。`)) return;
      await apiJson(`/knowledge-bases/${encodeURIComponent(selectedKbId)}`, { method: "DELETE" });
      await refreshKb();
      setSelectedKbId(kbIds.find((id) => id !== selectedKbId) || "");
      showToast("知识库已删除");
    } else if (action === "refresh") {
      await refreshKb();
      showToast("刷新成功");
    }
  };

  const handleItemAction = async (action: string) => {
    if (!selectedKbId && action !== "refresh") return showToast("请先选择知识库", "error");
    if (action === "add") {
      openEdit({ id: allocateId(), question: "", variants: [], answer: "", enabled: true });
    } else if (action === "batchAdd") {
      showModal(
        "新增标准问题",
        <div>
          <p style={{ margin: "0 0 10px", color: "var(--text-secondary)", fontSize: 13 }}>可添加多组问题，一次批量提交。</p>
          <div id="multiItemBlocks">
            <div className="multiItemBlock">
              <label className="fieldLabel">标准问题<textarea className="multiQ" rows={2} /></label>
              <label className="fieldLabel">其他问法（每行一条）<textarea className="multiV" rows={2} /></label>
              <label className="fieldLabel">回答 Markdown<textarea className="multiA" rows={4} /></label>
            </div>
          </div>
        </div>,
        async () => {
          const blocks = document.querySelectorAll("#multiItemBlocks .multiItemBlock");
          const occupied = new Set((doc.items || []).map((x) => x.id));
          let count = 0;
          for (const block of blocks) {
            const question = (block.querySelector(".multiQ") as HTMLTextAreaElement)?.value.trim();
            const answer = (block.querySelector(".multiA") as HTMLTextAreaElement)?.value.trim();
            const variants = ((block.querySelector(".multiV") as HTMLTextAreaElement)?.value || "").split("\n").map((s) => s.trim()).filter(Boolean);
            if (!question && !answer) continue;
            if (!question) throw new Error("标准问题不能为空");
            if (!answer) throw new Error("回答不能为空");
            const id = allocateId(occupied);
            occupied.add(id);
            await apiJson(`${questionsBase(selectedKbId)}/items`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, question, variants, answer, enabled: true }),
            });
            count += 1;
          }
          if (!count) throw new Error("请至少填写一组问题");
          await refreshKb();
          await loadItems(selectedKbId);
          showToast(`已新增 ${count} 条`);
        },
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
      await refreshKb();
      await loadItems(selectedKbId);
      showToast(enabled ? "已启用选中" : "已禁用选中");
    } else if (action === "deleteSelected") {
      if (!checkedIds.size) return showToast("请先勾选条目", "error");
      if (!confirm(`确定删除选中的 ${checkedIds.size} 条？`)) return;
      for (const id of checkedIds) {
        await apiJson(`${questionsBase(selectedKbId)}/items/${encodeURIComponent(id)}`, { method: "DELETE" });
      }
      setCheckedIds(new Set());
      if (manageMode === "llm") await refreshKb();
      await loadItems(selectedKbId);
      showToast("已删除");
    }
  };

  return (
    <div className="manageLayout manageLayoutItems">
      <section className="manageCol manageKbCol">
        <div className="stripHead">
          <span>知识库</span>
          <span className="headActions">
            <Dropdown label="操作">
              <button type="button" className="dropdownItem" data-kb-action="add" onClick={() => void handleKbAction("add")}>新增知识库</button>
              <button type="button" className="dropdownItem" data-kb-action="refresh" onClick={() => void handleKbAction("refresh")}>刷新列表</button>
              <div className="dropdownDivider" />
              <button type="button" className="dropdownItem" data-kb-action="rename" onClick={() => void handleKbAction("rename")}>重命名</button>
              <button type="button" className="dropdownItem" data-kb-action="reload" onClick={() => void handleKbAction("reload")}>重新加载索引</button>
              <div className="dropdownDivider" />
              <button type="button" className="dropdownItem danger" data-kb-action="delete" onClick={() => void handleKbAction("delete")}>删除知识库</button>
            </Dropdown>
          </span>
        </div>
        <div id="kbList" className="scrollInner listBody">
          {kbIds.length ? kbIds.map((id) => (
            <div key={id} className={`listItem ${id === selectedKbId ? "active" : ""}`} data-kb-id={id} onClick={() => { setSelectedKbId(id); setCheckedIds(new Set()); }}>
              <div className="listItemContent">
                <div>{kbDisplayName(id)}</div>
                <div className="sub">kb_{id} · {kbMap[id]?.enabled_count ?? 0} 题</div>
              </div>
            </div>
          )) : <div className="empty">暂无知识库</div>}
        </div>
      </section>

      <section className="manageCol manageItemsMain">
        <ModeBar label="FAQ 模式" mode={manageMode} onChange={(m) => { setManageMode(m); setEditItem(null); setCheckedIds(new Set()); }} />
        <div className="stripHead manageItemsHead">
          <span>{manageMode === "rag" ? "RAG 标准问题" : "标准问题"}</span>
          <span className="headActions manageItemsHeadActions">
            {manageMode === "rag" && selectedKbId && <IndexStatusPill kbId={selectedKbId} onRebuild={() => void loadItems(selectedKbId)} />}
            <input id="itemSearch" type="search" className="itemSearchInput" placeholder="搜索问题…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Dropdown label="操作">
              <button type="button" className="dropdownItem" data-item-action="add" onClick={() => void handleItemAction("add")}>新增问题</button>
              <button type="button" className="dropdownItem" data-item-action="batchAdd" onClick={() => void handleItemAction("batchAdd")}>批量新增</button>
              <button type="button" className="dropdownItem" data-item-action="refresh" onClick={() => void handleItemAction("refresh")}>刷新列表</button>
              <div className="dropdownDivider" />
              <button type="button" className="dropdownItem" data-item-action="selectAll" onClick={() => void handleItemAction("selectAll")}>全选</button>
              <button type="button" className="dropdownItem" data-item-action="selectNone" onClick={() => void handleItemAction("selectNone")}>取消全选</button>
              <button type="button" className="dropdownItem" data-item-action="invertSelect" onClick={() => void handleItemAction("invertSelect")}>反选</button>
              <div className="dropdownDivider" />
              <button type="button" className="dropdownItem" data-item-action="enableSelected" onClick={() => void handleItemAction("enableSelected")}>启用选中</button>
              <button type="button" className="dropdownItem" data-item-action="disableSelected" onClick={() => void handleItemAction("disableSelected")}>禁用选中</button>
              <button type="button" className="dropdownItem danger" data-item-action="deleteSelected" onClick={() => void handleItemAction("deleteSelected")}>删除选中</button>
            </Dropdown>
          </span>
        </div>
        <div id="itemList" className="scrollInner itemCardGrid">
          {!selectedKbId ? <div className="empty">请选择知识库</div> : visible.length ? visible.map((it) => (
            <div key={it.id} className={`itemCard${it.enabled === false ? " disabled" : ""}${it.id === selectedItemId ? " active" : ""}`} data-item-id={it.id} onClick={() => openEdit(it)}>
              <label className="itemCardCheck" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" className="itemCheck" data-item-id={it.id} checked={checkedIds.has(it.id)} onChange={(e) => {
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
        <div className="modal modalWide">
          <div className="modalHead">
            <span>编辑标准问题</span>
            <button type="button" id="itemEditBackBtn" className="btn btnXs ghost" onClick={closeEdit}>返回</button>
          </div>
          <div className="modalBody itemEditBody">
            <div className="stripHead editorTabHead" style={{ border: "none", padding: "0 0 10px" }}>
              <div className="leftTabs">
                <button type="button" className={`tabBtn ${editorTab === "item" ? "active" : ""}`} data-editor-tab="item" onClick={() => setEditorTab("item")}>问题编辑</button>
                <button type="button" className={`tabBtn ${editorTab === "json" ? "active" : ""}`} data-editor-tab="json" onClick={() => { setJsonText(JSON.stringify(editItem, null, 2)); setEditorTab("json"); }}>JSON 源码</button>
              </div>
            </div>
            <div className="editorBody">
              <div id="editorTabItem" className={`editorPane ${editorTab === "item" ? "active" : ""}`}>
                <label className="fieldLabel">ID<input id="editId" type="text" readOnly value={editItem?.id || ""} /></label>
                <label className="fieldLabel">标准问题<textarea id="editQuestion" rows={2} value={editItem?.question || ""} onChange={(e) => editItem && setEditItem({ ...editItem, question: e.target.value })} /></label>
                <label className="fieldLabel">其他问法（每行一条）<textarea id="editVariants" rows={3} value={(editItem?.variants || []).join("\n")} onChange={(e) => editItem && setEditItem({ ...editItem, variants: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} /></label>
                <label className="fieldLabel">回答（Markdown）</label>
                <div className="mdEditorWrap">
                  <div className="mdEditorToolbar">
                    <div className="segmentedControl" id="editAnswerSegment">
                      <button type="button" className={`segmentedBtn ${answerTab === "edit" ? "active" : ""}`} id="editAnswerTabEdit" onClick={() => setAnswerTab("edit")}>编辑</button>
                      <button type="button" className={`segmentedBtn ${answerTab === "preview" ? "active" : ""}`} id="editAnswerTabPreview" onClick={() => setAnswerTab("preview")}>预览</button>
                    </div>
                  </div>
                  <div id="editAnswerEditPane" className={answerTab === "preview" ? "hidden" : ""}>
                    <textarea id="editAnswer" rows={10} spellCheck={false} value={editItem?.answer || ""} onChange={(e) => editItem && setEditItem({ ...editItem, answer: e.target.value })} />
                  </div>
                  <div id="editAnswerPreviewPane" className={`answerPreviewBox mdPreview${answerTab === "preview" ? "" : " hidden"}`}>
                    {editItem && <MarkdownPreview md={editItem.answer} kbId={selectedKbId} />}
                  </div>
                </div>
                <label className="fieldCheck"><input id="editEnabled" type="checkbox" checked={editItem?.enabled !== false} onChange={(e) => editItem && setEditItem({ ...editItem, enabled: e.target.checked })} /> 启用匹配</label>
              </div>
              <div id="editorTabJson" className={`editorPane ${editorTab === "json" ? "active" : ""}`}>
                <textarea id="jsonEditor" className="jsonEditor" spellCheck={false} rows={16} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="modalFoot">
            <button type="button" id="itemEditSaveBtn" className="btn primary btnXs" onClick={() => void saveEditor().catch((e) => showToast(e.message, "error"))}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}
