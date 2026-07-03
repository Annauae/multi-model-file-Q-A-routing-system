import { useState } from "react";
import type { FileTreeNode } from "../types";
import { canConvertKind, canQuestionGenKind, kindLabel } from "./documentTypes";

function isFolder(node: FileTreeNode) {
  return node.type === "folder" || !!(node.children && node.children.length);
}

export function filterTreeQuestionGenEligible(nodes: FileTreeNode[]): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const node of nodes || []) {
    if (isFolder(node)) {
      const children = filterTreeQuestionGenEligible(node.children || []);
      if (children.length) out.push({ ...node, children });
    } else if (node.kind && canQuestionGenKind(node.kind)) {
      out.push(node);
    }
  }
  return out;
}

/** @deprecated use filterTreeQuestionGenEligible */
export function filterTreeMarkdownOnly(nodes: FileTreeNode[]): FileTreeNode[] {
  return filterTreeQuestionGenEligible(nodes);
}

export function filterTreeConvertEligible(nodes: FileTreeNode[]): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const node of nodes || []) {
    if (isFolder(node)) {
      const children = filterTreeConvertEligible(node.children || []);
      if (children.length) out.push({ ...node, children });
    } else if (node.kind && canConvertKind(node.kind)) {
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
  treeFilter,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath: string;
  onSelect: (node: FileTreeNode) => void;
  treeFilter: "all" | "questionGen" | "convert";
}) {
  const [expanded, setExpanded] = useState(true);
  const pad = depth * 14;
  const children = (node.children || [])
    .map((c) => (
      <FileTreeNodeView key={`${node.name}/${c.name}/${c.path || ""}`} node={c} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} treeFilter={treeFilter} />
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
  treeFilter,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath: string;
  onSelect: (node: FileTreeNode) => void;
  treeFilter: "all" | "questionGen" | "convert";
}) {
  if (treeFilter === "questionGen" && node.kind && !canQuestionGenKind(node.kind)) return null;
  if (treeFilter === "convert" && node.kind && !canConvertKind(node.kind)) return null;
  if (isFolder(node)) {
    return <FileTreeFolder node={node} depth={depth} selectedPath={selectedPath} onSelect={onSelect} treeFilter={treeFilter} />;
  }
  const pad = depth * 14 + 18;
  const label = kindLabel(node.kind || "");
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
      <span className={`fileKindBadge ${kindClass}`}>{label}</span>
      <span className="fileTreeName">{node.name}</span>
      {node.line_count ? <span className="fileTreeMeta muted">{node.line_count} 行</span> : null}
    </button>
  );
}

export function renderFileTreeNodes(
  nodes: FileTreeNode[],
  selectedPath: string,
  onSelect: (node: FileTreeNode) => void,
  treeFilter: "all" | "questionGen" | "convert" = "all",
) {
  const list = treeFilter === "questionGen"
    ? filterTreeQuestionGenEligible(nodes)
    : treeFilter === "convert"
      ? filterTreeConvertEligible(nodes)
      : nodes;
  if (!list.length) return <div className="empty muted">暂无文件</div>;
  return list.map((node) => (
    <FileTreeNodeView key={`${node.name}/${node.path || "folder"}`} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} treeFilter={treeFilter} />
  ));
}

export function LineViewer({ markdown, lineStart, lineEnd, activeSelectionId, selections }: {
  markdown: string;
  lineStart?: number;
  lineEnd?: number;
  activeSelectionId?: string;
  selections?: { id: string; lineStart: number; lineEnd: number }[];
}) {
  const lines = markdown.split(/\r?\n/);
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

/** @deprecated use LineViewer */
export const MdLineViewer = LineViewer;

export function sliceMarkdownLines(markdown: string, start: number, end: number): string {
  const lines = markdown.split(/\r?\n/);
  return lines.slice(Math.max(0, start - 1), end).join("\n");
}

export function documentTextForLines(doc: { content?: string | null; markdown?: string; text_lines?: string[] }): string {
  if (doc.text_lines?.length) return doc.text_lines.join("\n");
  return doc.content ?? doc.markdown ?? "";
}

/** 修正 multer latin1 误解码导致的中文文件名乱码（仅用于展示） */
export function tryFixMojibakeFilename(name: string): string {
  if (/[\u4e00-\u9fff]/.test(name)) return name;
  try {
    const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0) & 0xff);
    const decoded = new TextDecoder("utf-8").decode(bytes);
    if (/[\u4e00-\u9fff]/.test(decoded)) return decoded;
  } catch {
    /* ignore */
  }
  return name;
}

export function displayFileName(path: string, name?: string): string {
  if (name?.trim()) return name;
  const base = path.split("/").pop() || path;
  return tryFixMojibakeFilename(base);
}

export function sourceFileExists(tree: FileTreeNode[], fileName: string): boolean {
  const base = fileName.trim();
  const walk = (nodes: FileTreeNode[]): boolean => {
    for (const n of nodes || []) {
      if (n.children?.length) {
        if (walk(n.children)) return true;
      } else if (n.name === base && n.kind?.startsWith("source_")) {
        return true;
      }
    }
    return false;
  };
  return walk(tree);
}
