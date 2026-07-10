import { useState } from "react";
import { MarkdownPreview } from "./MarkdownPreview";
import { MdSourceEditor } from "./MdSourceEditor";

/** Markdown 编辑器：编辑 / 预览切换（单栏展示） */
export function MarkdownEditor({
  value,
  onChange,
  kbId,
  showLineNumbers = false,
  minHeight = 320,
}: {
  value: string;
  onChange: (v: string) => void;
  kbId: string;
  showLineNumbers?: boolean;
  minHeight?: number;
}) {
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  return (
    <div className="markdownEditor markdownEditorToggle" style={{ minHeight }}>
      <div className="mdEditorToolbar">
        <div className="segmentedControl">
          <button type="button" className={`segmentedBtn ${tab === "edit" ? "active" : ""}`} onClick={() => setTab("edit")}>编辑</button>
          <button type="button" className={`segmentedBtn ${tab === "preview" ? "active" : ""}`} onClick={() => setTab("preview")}>预览</button>
        </div>
      </div>
      {tab === "edit" ? (
        <MdSourceEditor value={value} onChange={onChange} showLineNumbers={showLineNumbers} />
      ) : (
        <div className="markdownEditorPreview mdPreview">
          <MarkdownPreview md={value} kbId={kbId} />
        </div>
      )}
    </div>
  );
}
