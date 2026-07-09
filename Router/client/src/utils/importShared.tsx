import { useState } from "react";
import type { FileTreeNode } from "../types";
import { canConvertKind, canQuestionGenKind, kindLabel } from "./documentTypes";

/** 判断是否为文件夹 */
function isFolder(node: FileTreeNode) {
  return node.type === "folder" || !!(node.children && node.children.length);
}

/** 过滤出可生成问题的文件节点 */
export function filterTreeQuestionGenEligible(nodes: FileTreeNode[]): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const node of nodes || []) {
    if (isFolder(node)) {
      // 递归处理子文件夹
      const children = filterTreeQuestionGenEligible(node.children || []);
      if (children.length) out.push({ ...node, children }); // 如果子文件夹有可生成问题的文件，则将子文件夹添加到结果中
    } else if (node.kind && canQuestionGenKind(node.kind)) {
      out.push(node); // 如果节点是可生成问题的文件，则将节点添加到结果中
    }
  }
  return out;
}

/** 过滤出可转换成markdown的文件节点 */
export function filterTreeMarkdownOnly(nodes: FileTreeNode[]): FileTreeNode[] {
  return filterTreeQuestionGenEligible(nodes); 
}

/** 过滤出可转换的文件节点 */
export function filterTreeConvertEligible(nodes: FileTreeNode[]): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const node of nodes || []) { 
    if (isFolder(node)) {
      const children = filterTreeConvertEligible(node.children || []); // 递归处理子文件夹
      if (children.length) out.push({ ...node, children });
    } else if (node.kind && canConvertKind(node.kind)) {
      out.push(node); // 如果节点是可转换的文件，则将节点添加到结果中
    }
  }
  return out;
}

/** 从 API 树中拆出 sources / modules 文件列表（跳过 documents 顶层） */
export function unwrapDocumentSections(tree: FileTreeNode[]): { sources: FileTreeNode[]; modules: FileTreeNode[] } {
  let sections = tree;
  const docs = tree.find((n) => n.name === "documents");
  if (docs?.children?.length) sections = docs.children;
  const sourcesFolder = sections.find((n) => n.name === "sources");
  const modulesFolder = sections.find((n) => n.name === "modules");
  return {
    sources: sourcesFolder?.children?.filter((n) => !isFolder(n)) || [],
    modules: modulesFolder?.children?.filter((n) => !isFolder(n)) || [],
  };
}

function filterFileNodes(nodes: FileTreeNode[], treeFilter: "all" | "questionGen" | "convert"): FileTreeNode[] {
  if (treeFilter === "questionGen") return nodes.filter((n) => n.kind && canQuestionGenKind(n.kind));
  if (treeFilter === "convert") return nodes.filter((n) => n.kind && canConvertKind(n.kind));
  return nodes;
}

/** 单文件行 */
function FileTreeFileRow({
  node,
  selectedPath,
  onSelect,
}: {
  node: FileTreeNode;
  selectedPath: string;
  onSelect: (node: FileTreeNode) => void;
}) {
  const label = kindLabel(node.kind || "");
  const kindClass = node.kind === "source_pdf" ? "fileKindPdf" : "fileKindMd";
  return (
    <button
      type="button"
      className={`fileTreeFile${node.kind === "source_pdf" ? " fileTreePdf" : ""}${selectedPath === node.path ? " active" : ""}`}
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

/** 气泡分组：已上传文件 / 转换 md 文件 */
function FileTreeBubbleSection({
  label,
  files,
  selectedPath,
  onSelect,
  defaultOpen = true,
}: {
  label: string;
  files: FileTreeNode[];
  selectedPath: string;
  onSelect: (node: FileTreeNode) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="fileTreeBubbleSection">
      <button
        type="button"
        className={`fileTreeBubble${open ? " open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="fileTreeBubbleText">{label}</span>
        <span className="fileTreeBubbleMeta">
          <span className="fileTreeBubbleCount">{files.length}</span>
          <span className="fileTreeBubbleChevron" aria-hidden>{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {files.length > 0 && (
        <div className={`fileTreeBubbleBody${open ? "" : " collapsed"}`}>
          {files.map((node) => (
            <FileTreeFileRow key={node.path || node.name} node={node} selectedPath={selectedPath} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 左侧分类栏：气泡 + 可折叠文件列表，点击滚动定位 */
export function FileCategorySidebar({
  tree,
  selectedPath,
  onScrollToFile,
}: {
  tree: FileTreeNode[];
  selectedPath: string;
  onScrollToFile: (node: FileTreeNode) => void;
}) {
  const { sources, modules } = unwrapDocumentSections(tree);
  return (
    <div className="fileTree scrollInner">
      <div className="fileTreeBubbles">
        <FileTreeBubbleSection label="已上传文件" files={sources} selectedPath={selectedPath} onSelect={onScrollToFile} defaultOpen />
        <FileTreeBubbleSection label="转换 md 文件" files={modules} selectedPath={selectedPath} onSelect={onScrollToFile} defaultOpen />
      </div>
    </div>
  );
}

/** 文件管理：气泡式 sources / modules 展示 */
export function renderDocumentFileTree(
  nodes: FileTreeNode[],
  selectedPath: string,
  onSelect: (node: FileTreeNode) => void,
  treeFilter: "all" | "questionGen" | "convert" = "all",
) {
  const { sources, modules } = unwrapDocumentSections(nodes);
  const srcFiles = filterFileNodes(sources, treeFilter);
  const modFiles = treeFilter === "convert" ? [] : filterFileNodes(modules, treeFilter);
  if (!srcFiles.length && !modFiles.length) return <div className="empty muted">暂无文件</div>;
  return (
    <div className="fileTreeBubbles">
      {srcFiles.length > 0 && (
        <FileTreeBubbleSection label="已上传文件" files={srcFiles} selectedPath={selectedPath} onSelect={onSelect} />
      )}
      {modFiles.length > 0 && (
        <FileTreeBubbleSection label="转换 md 文件" files={modFiles} selectedPath={selectedPath} onSelect={onSelect} />
      )}
    </div>
  );
}

/** 文件夹节点视图（旧树形，弹窗等仍可用） */
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
  const [expanded, setExpanded] = useState(true); // 是否展开
  const pad = depth * 14;
  const children = (node.children || [])
    .map((c) => ( // 递归渲染子节点
      <FileTreeNodeView key={`${node.name}/${c.name}/${c.path || ""}`} node={c} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} treeFilter={treeFilter} />
    ))
    .filter(Boolean); // 过滤掉空的子节点

  return ( // 渲染文件夹节点
    <div className="fileTreeFolder" style={{ paddingLeft: pad }}>
      <button
        type="button"
        className="fileTreeToggle"
        data-expanded={expanded ? "1" : "0"}
        onClick={() => setExpanded(!expanded)} // 点击折叠/展开
      >
        {expanded ? "▾" : "▸"} {node.name}/
      </button>
      <div className={`fileTreeChildren${expanded ? "" : " collapsed"}`}>{children}</div>
    </div>
  );
}

/** 文件节点视图 */
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
  if (treeFilter === "questionGen" && node.kind && !canQuestionGenKind(node.kind)) return null; // 如果节点是不可生成问题的文件，则返回空
  if (treeFilter === "convert" && node.kind && !canConvertKind(node.kind)) return null; // 如果节点是不可转换的文件，则返回空
  if (isFolder(node)) {
    return <FileTreeFolder node={node} depth={depth} selectedPath={selectedPath} onSelect={onSelect} treeFilter={treeFilter} />; // 渲染文件夹节点
  }
  const pad = depth * 14 + 18;
  const label = kindLabel(node.kind || "");
  const kindClass = node.kind === "source_pdf" ? "fileKindPdf" : "fileKindMd";
  return ( // 渲染文件节点
    <button
      type="button"
      className={`fileTreeFile${node.kind === "source_pdf" ? " fileTreePdf" : ""}${selectedPath === node.path ? " active" : ""}`}
      style={{ paddingLeft: pad }}
      data-path={node.path}
      data-kind={node.kind}
      data-name={node.name}
      onClick={() => onSelect(node)} // 点击选择节点
    >
      <span className={`fileKindBadge ${kindClass}`}>{label}</span>
      <span className="fileTreeName">{node.name}</span>
      {/* 显示行数 */}
      {node.line_count ? <span className="fileTreeMeta muted">{node.line_count} 行</span> : null} 
    </button>
  );
}

/** 渲染文件树节点 */
export function renderFileTreeNodes(
  nodes: FileTreeNode[],
  selectedPath: string,
  onSelect: (node: FileTreeNode) => void,
  treeFilter: "all" | "questionGen" | "convert" = "all",
) {
  const list = treeFilter === "questionGen" // 过滤出可生成问题的文件节点
    ? filterTreeQuestionGenEligible(nodes)
    : treeFilter === "convert" // 过滤出可转换的文件节点
      ? filterTreeConvertEligible(nodes)
      : nodes;
  if (!list.length) return <div className="empty muted">暂无文件</div>; // 如果列表为空，则返回空
  return list.map((node) => (
    <FileTreeNodeView key={`${node.name}/${node.path || "folder"}`} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} treeFilter={treeFilter} />
  ));
}

/** 行数查看器 */
export function LineViewer({ markdown, lineStart, lineEnd, activeSelectionId, selections }: {
  markdown: string;
  lineStart?: number;
  lineEnd?: number;
  activeSelectionId?: string;
  selections?: { id: string; lineStart: number; lineEnd: number }[];
}) {
  const lines = markdown.split(/\r?\n/); // 分割成行
  return (
    <div className="mdLineViewer">
      {lines.map((line, i) => {
        const ln = i + 1; // 行号
        let cls = "mdLineRow";
        if (lineStart && lineEnd && ln >= lineStart && ln <= lineEnd) cls += " mdLineActive"; // 用户当前正在框选/编辑的范围
        if (selections?.some((s) => s.id === activeSelectionId && ln >= s.lineStart && ln <= s.lineEnd)) cls += " mdLineSelected"; // 用户当前选中的范围
        if (selections?.length && activeSelectionId && !selections.some((s) => s.id === activeSelectionId && ln >= s.lineStart && ln <= s.lineEnd) && selections.some((s) => ln >= s.lineStart && ln <= s.lineEnd)) cls += " mdLineDimmed"; // 多选区并存时，把非激活选区变淡，突出当前正在操作的那一块。
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

/** 切片 markdown 行 */
export function sliceMarkdownLines(markdown: string, start: number, end: number): string {
  const lines = markdown.split(/\r?\n/); // 分割成行
  return lines.slice(Math.max(0, start - 1), end).join("\n");
}

/** 获取文档文本 */
export function documentTextForLines(doc: { content?: string | null; markdown?: string; text_lines?: string[] }): string {
  if (doc.text_lines?.length) return doc.text_lines.join("\n"); // 如果文本行数不为空，则返回文本行数
  return doc.content ?? doc.markdown ?? ""; // 如果文本行数为空，则返回内容或markdown
}

/** 修正 multer latin1 误解码导致的中文文件名乱码（仅用于展示） */
export function tryFixMojibakeFilename(name: string): string {
  if (/[\u4e00-\u9fff]/.test(name)) return name; // 如果文件名包含中文，则返回文件名
  try {
    const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0) & 0xff);
    const decoded = new TextDecoder("utf-8").decode(bytes); // 解码文件名
    if (/[\u4e00-\u9fff]/.test(decoded)) return decoded;
  } catch {
    /* ignore */ // 如果解码失败，则忽略
  }
  return name; // 返回文件名
}

/** 显示文件名 */
export function displayFileName(path: string, name?: string): string {
  if (name?.trim()) return name; // 如果文件名不为空，则返回文件名
  const base = path.split("/").pop() || path;
  return tryFixMojibakeFilename(base); // 修正文件名
}

/** 判断文件是否存在 */
export function sourceFileExists(tree: FileTreeNode[], fileName: string): boolean {
  const base = fileName.trim();
  const walk = (nodes: FileTreeNode[]): boolean => {
    for (const n of nodes || []) {
      if (n.children?.length) {
        if (walk(n.children)) return true; // 如果子文件夹有文件，则返回true
      } else if (n.name === base && n.kind?.startsWith("source_")) {
        return true; // 如果文件名和文件类型匹配，则返回true
      }
    }
    return false;
  };
  return walk(tree); // 遍历文件树，判断文件是否存在
}
