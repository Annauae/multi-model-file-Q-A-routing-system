import { useState } from "react";
import type { FileTreeNode } from "../types";

function isFolder(node: FileTreeNode) {
  return node.type === "folder" || !!(node.children && node.children.length);
}

export function filterTreeMarkdownOnly(nodes: FileTreeNode[]): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const node of nodes || []) {
    if (isFolder(node)) {
      const children = filterTreeMarkdownOnly(node.children || []);
      if (children.length) out.push({ ...node, children });
    } else if (node.kind !== "source_pdf" && (node.kind === "source_md" || node.kind === "module_md")) {
      out.push(node);
    }
  }
  return out;
}

function FileTreeFolder({
  node,
  depth,
  selectedPath,
  onSelect,
  mdOnly,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath: string;
  onSelect: (node: FileTreeNode) => void;
  mdOnly: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const pad = depth * 14;
  const children = (node.children || [])
    .map((c) => (
      <FileTreeNodeView key={`${node.name}/${c.name}/${c.path || ""}`} node={c} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} mdOnly={mdOnly} />
    ))
    .filter(Boolean);

  return (
    <div className="fileTreeFolder" style={{ paddingLeft: pad }}>
      <button
        type="button"
        className="fileTreeToggle"
        data-expanded={expanded ? "1" : "0"}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "▾" : "▸"} {node.name}/
      </button>
      <div className={`fileTreeChildren${expanded ? "" : " collapsed"}`}>{children}</div>
    </div>
  );
}

function FileTreeNodeView({
  node,
  depth,
  selectedPath,
  onSelect,
  mdOnly,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath: string;
  onSelect: (node: FileTreeNode) => void;
  mdOnly: boolean;
}) {
  if (mdOnly && node.kind === "source_pdf") return null;
  if (isFolder(node)) {
    return <FileTreeFolder node={node} depth={depth} selectedPath={selectedPath} onSelect={onSelect} mdOnly={mdOnly} />;
  }
  const pad = depth * 14 + 18;
  const kindLabel = node.kind === "source_pdf" ? "PDF" : "MD";
  const kindClass = node.kind === "source_pdf" ? "fileKindPdf" : "fileKindMd";
  return (
    <button
      type="button"
      className={`fileTreeFile${node.kind === "source_pdf" ? " fileTreePdf" : ""}${selectedPath === node.path ? " active" : ""}`}
      style={{ paddingLeft: pad }}
      data-path={node.path}
      data-kind={node.kind}
      data-name={node.name}
      onClick={() => onSelect(node)}
    >
      <span className={`fileKindBadge ${kindClass}`}>{kindLabel}</span>
      <span className="fileTreeName">{node.name}</span>
      {node.line_count ? <span className="fileTreeMeta muted">{node.line_count} 行</span> : null}
    </button>
  );
}

export function renderFileTreeNodes(nodes: FileTreeNode[], selectedPath: string, onSelect: (node: FileTreeNode) => void, mdOnly = false) {
  const list = mdOnly ? filterTreeMarkdownOnly(nodes) : nodes;
  if (!list.length) return <div className="empty muted">暂无文件</div>;
  return list.map((node) => (
    <FileTreeNodeView key={`${node.name}/${node.path || "folder"}`} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} mdOnly={mdOnly} />
  ));
}

export function MdLineViewer({ markdown, lineStart, lineEnd, activeSelectionId, selections }: {
  markdown: string;
  lineStart?: number;
  lineEnd?: number;
  activeSelectionId?: string;
  selections?: { id: string; lineStart: number; lineEnd: number }[];
}) {
  const lines = markdown.split("\n");
  return (
    <div className="mdLineViewer">
      {lines.map((line, i) => {
        const ln = i + 1;
        let cls = "mdLineRow";
        if (lineStart && lineEnd && ln >= lineStart && ln <= lineEnd) cls += " mdLineActive";
        if (selections?.some((s) => s.id === activeSelectionId && ln >= s.lineStart && ln <= s.lineEnd)) cls += " mdLineSelected";
        if (selections?.length && activeSelectionId && !selections.some((s) => s.id === activeSelectionId && ln >= s.lineStart && ln <= s.lineEnd) && selections.some((s) => ln >= s.lineStart && ln <= s.lineEnd)) cls += " mdLineDimmed";
        return (
          <div key={ln} className={cls}>
            <span className="mdLineNo">{ln}</span>
            <span className="mdLineContent">{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

export function sliceMarkdownLines(markdown: string, start: number, end: number): string {
  const lines = markdown.split("\n");
  return lines.slice(Math.max(0, start - 1), end).join("\n");
}
