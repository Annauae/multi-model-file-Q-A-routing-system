/** 文件网格面板 — 按分类展示文件卡片 */

import { useEffect, useState } from "react";
import type { FileTreeNode } from "../types";
import { unwrapDocumentSections } from "../utils/importShared";
import { FileGridCard, fileCardDomId } from "./FileGridCard";

export function FileGridPanel({
  tree,
  selectedPath,
  scrollTargetPath,
  onOpenFile,
  onRename,
  onDelete,
}: {
  tree: FileTreeNode[];
  selectedPath?: string;
  scrollTargetPath?: string | null;
  onOpenFile: (node: FileTreeNode) => void;
  onRename: (node: FileTreeNode) => void;
  onDelete: (node: FileTreeNode) => void;
}) {
  const { sources, modules } = unwrapDocumentSections(tree);
  const [highlightPath, setHighlightPath] = useState<string | null>(null);

  useEffect(() => {
    if (!scrollTargetPath) return;
    const el = document.getElementById(fileCardDomId(scrollTargetPath));
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setHighlightPath(scrollTargetPath);
      const t = window.setTimeout(() => setHighlightPath(null), 1800);
      return () => window.clearTimeout(t);
    }
  }, [scrollTargetPath, tree]);

  const renderSection = (label: string, files: FileTreeNode[], sectionId: string) => (
    <section id={sectionId} className="fileGridSection">
      <h3 className="fileGridSectionTitle">{label} ({files.length})</h3>
      {files.length === 0 ? (
        <div className="muted fileGridEmpty">暂无文件</div>
      ) : (
        <div className="fileGrid">
          {files.map((node) => (
            <FileGridCard
              key={node.path || node.name}
              node={node}
              selectedPath={selectedPath}
              highlighted={highlightPath === node.path}
              onOpen={onOpenFile}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  );

  if (!sources.length && !modules.length) {
    return <div className="muted filesEmptyHint fileGridPanelEmpty">暂无文件，请上传或新建</div>;
  }

  return (
    <div className="fileGridPanel scrollInner">
      {renderSection("已上传文件", sources, "files-section-sources")}
      {renderSection("转换 md 文件", modules, "files-section-modules")}
    </div>
  );
}
