import DOMPurify from "dompurify";
import { MarkdownPreview } from "./MarkdownPreview";
import { MdSourceEditor } from "./MdSourceEditor";
import { isEditableKind, isPreviewOnlyKind } from "../utils/documentTypes";

export interface DocumentContent {
  path: string;
  kind: string;
  format?: string;
  editable?: boolean;
  content?: string | null;
  markdown?: string;
  preview_html?: string | null;
  text_lines?: string[];
  line_count?: number;
  warnings?: string[];
}

export function DocumentEditorPane({
  selected,
  content,
  editMode,
  text,
  onChange,
}: {
  selected: { path: string; kind: string; name: string } | null;
  content: DocumentContent | null;
  editMode: "source" | "preview";
  text: string;
  onChange: (v: string) => void;
}) {
  if (!selected) {
    return <div className="muted filesEmptyHint">从左侧选择文件…</div>;
  }

  const kind = selected.kind;
  const previewOnly = isPreviewOnlyKind(kind) || content?.editable === false;

  if (kind === "source_pdf" && editMode === "preview") {
    return (
      <iframe
        title={selected.name}
        className="filesPdfPreview"
        src={`/documents/preview-file?path=${encodeURIComponent(selected.path)}`}
      />
    );
  }

  if (previewOnly && editMode === "preview" && content?.preview_html) {
    const html = DOMPurify.sanitize(content.preview_html);
    return (
      <div className="docPreviewHtml mdPreview" dangerouslySetInnerHTML={{ __html: html }} />
    );
  }

  if (previewOnly && editMode === "preview" && kind === "source_docx" && text) {
    return <MarkdownPreview md={text} kbId="documents" />;
  }

  if (previewOnly && editMode === "preview" && kind === "source_json") {
    return <pre className="jsonPreview">{text}</pre>;
  }

  if (previewOnly) {
    return (
      <div className="filesPreviewHint muted">
        <p>此格式不可直接编辑，请使用「文件转 Markdown」转换后在 modules 中编辑。</p>
        {content?.warnings?.map((w, i) => <p key={i}>{w}</p>)}
      </div>
    );
  }

  if (editMode === "preview") {
    if (kind === "source_json") {
      return <pre className="jsonPreview">{text}</pre>;
    }
    if (kind === "source_html") {
      const html = content?.preview_html
        ? DOMPurify.sanitize(content.preview_html)
        : DOMPurify.sanitize(text);
      return <div className="docPreviewHtml mdPreview" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    return <MarkdownPreview md={text} kbId="documents" />;
  }

  if (isEditableKind(kind)) {
    return (
      <MdSourceEditor
        id="filesEditSource"
        value={text}
        onChange={onChange}
        showLineNumbers
        placeholder="编辑文件内容…"
      />
    );
  }

  return null;
}
