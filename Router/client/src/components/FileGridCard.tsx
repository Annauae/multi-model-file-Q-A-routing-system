/** 文件网格卡片 */

import { useEffect, useRef, useState } from "react";
import type { FileTreeNode } from "../types";
import { kindLabel } from "../utils/documentTypes";

function kindDescription(kind: string): string {
  const map: Record<string, string> = {
    source_pdf: "PDF 文档",
    source_md: "Markdown 文档",
    source_txt: "文本文档",
    source_docx: "Word 文档",
    source_html: "HTML 文档",
    source_json: "JSON 文档",
    source_xlsx: "Excel 工作簿",
    source_xls: "Excel 工作簿",
    source_csv: "CSV 表格",
    module_md: "Markdown 文档",
  };
  return map[kind] || kindLabel(kind);
}

export function fileCardDomId(path: string): string {
  return `file-card-${encodeURIComponent(path)}`;
}

export function FileGridCard({
  node,
  selectedPath,
  highlighted,
  onOpen,
  onRename,
  onDelete,
}: {
  node: FileTreeNode;
  selectedPath?: string;
  highlighted?: boolean;
  onOpen: (node: FileTreeNode) => void;
  onRename: (node: FileTreeNode) => void;
  onDelete: (node: FileTreeNode) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const kind = node.kind || "";
  const kindClass = kind === "source_pdf" ? "fileKindPdf" : "fileKindMd";

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <div
      id={node.path ? fileCardDomId(node.path) : undefined}
      className={`fileGridCard${selectedPath === node.path ? " selected" : ""}${highlighted ? " fileGridCardHighlight" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(node)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(node); } }}
    >
      <span className={`fileGridCardIcon fileKindBadge ${kindClass}`}>{kindLabel(kind)}</span>
      <div className="fileGridCardInfo">
        <span className="fileGridCardName" title={node.name}>{node.name}</span>
        <span className="fileGridCardType muted">{kindDescription(kind)}</span>
        {node.line_count ? <span className="fileGridCardMeta muted">{node.line_count} 行</span> : null}
      </div>
      <div className="fileGridCardMenu" ref={menuRef}>
        <button
          type="button"
          className="fileGridCardMenuBtn"
          aria-label="文件操作"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="dropdownMenu fileGridCardDropdown" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="dropdownItem"
              onClick={() => { setMenuOpen(false); onRename(node); }}
            >
              重命名
            </button>
            <div className="dropdownDivider" />
            <button
              type="button"
              className="dropdownItem danger"
              onClick={() => { setMenuOpen(false); onDelete(node); }}
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
