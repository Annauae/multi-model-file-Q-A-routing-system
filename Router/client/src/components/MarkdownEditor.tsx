import { useEffect, useState } from "react";
import { MarkdownPreview } from "./MarkdownPreview";
import { MdSourceEditor } from "./MdSourceEditor";

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
  const [narrow, setNarrow] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (narrow) {
    return (
      <div className="markdownEditor markdownEditorNarrow" style={{ minHeight }}>
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

  return (
    <div className="markdownEditor markdownEditorSplit" style={{ minHeight }}>
      <div className="markdownEditorPane markdownEditorSource">
        <div className="markdownEditorPaneHead muted">编辑</div>
        <MdSourceEditor value={value} onChange={onChange} showLineNumbers={showLineNumbers} />
      </div>
      <div className="markdownEditorPane markdownEditorPreviewPane">
        <div className="markdownEditorPaneHead muted">预览</div>
        <div className="markdownEditorPreview mdPreview">
          <MarkdownPreview md={value} kbId={kbId} />
        </div>
      </div>
    </div>
  );
}
