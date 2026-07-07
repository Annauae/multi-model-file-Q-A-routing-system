/** 文档编辑器面板 */

import DOMPurify from "dompurify";
import { MarkdownPreview } from "./MarkdownPreview";
import { MdSourceEditor } from "./MdSourceEditor";
import { isEditableKind, isPreviewOnlyKind } from "../utils/documentTypes";

/** 文档内容 */
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
  display_name?: string;
  warnings?: string[];
}

export function DocumentEditorPane({
  selected,
  content,
  editMode,
  text,
  loading = false,
  onChange,
}: {
  selected: { path: string; kind: string; name: string } | null;
  content: DocumentContent | null;
  editMode: "source" | "preview";
  text: string;
  loading?: boolean;
  onChange: (v: string) => void;
}) {
  /** 如果未选择文件，则显示空提示 */
  if (!selected) {
    return <div className="muted filesEmptyHint">从左侧选择文件…</div>;
  }

  const kind = selected.kind; 
  const contentReady = !content?.path || content.path === selected.path;
  const previewOnly = isPreviewOnlyKind(kind) || content?.editable === false;
  const effectiveMode = previewOnly ? "preview" : editMode;
  const displayText = contentReady ? (text || content?.markdown || content?.content || "") : text;

  if (loading && kind !== "source_pdf") {
    return <div className="muted filesEmptyHint">正在加载…</div>;
  }

  if (!contentReady && kind !== "source_pdf" && !displayText) {
    return <div className="muted filesEmptyHint">正在加载…</div>;
  }

  /** 如果文件类型为 PDF，则显示 PDF 预览 */
  if (kind === "source_pdf" && effectiveMode === "preview") {
    return (
      <iframe
        title={selected.name}
        className="filesPdfPreview"
        src={`/documents/preview-file?path=${encodeURIComponent(selected.path)}`}
      />
    );
  }

  /** 预览 HTML 不为空，则显示预览 HTML */
  if (previewOnly && effectiveMode === "preview" && contentReady && content?.preview_html) {
    const html = DOMPurify.sanitize(content.preview_html);
    return (
      <div className="docPreviewHtml mdPreview" dangerouslySetInnerHTML={{ __html: html }} />
    );
  }

  /** 文本不为空，则显示 Markdown 预览 */
  if (previewOnly && effectiveMode === "preview" && displayText) {
    if (kind === "source_json") {
      return <pre className="jsonPreview">{displayText}</pre>;
    }
    return (
      <div className="filesMdPreviewPane">
        <MarkdownPreview md={displayText} kbId="documents" />
        {contentReady && content?.warnings?.map((w, i) => (
          <p key={i} className="muted filesPreviewWarn">{w}</p>
        ))}
      </div>
    );
  }

  /** 预览模式且内容准备好且文本为空，则显示预览提示 */
  if (previewOnly) {
    return (
      <div className="filesPreviewHint muted">
        <p>此格式不可直接编辑，请使用「文件转 Markdown」转换后在 modules 中编辑。</p>
        {contentReady && content?.warnings?.map((w, i) => <p key={i}>{w}</p>)}
      </div>
    );
  }

  /** 如果编辑模式为预览，则显示预览 */
  if (editMode === "preview") {
    if (kind === "source_json") {
      return <pre className="jsonPreview">{text}</pre>;
    }
    if (kind === "source_html") {
      const html = content?.preview_html // 如果预览 HTML 存在，则使用预览 HTML
        ? DOMPurify.sanitize(content.preview_html) // 清理预览 HTML
        : DOMPurify.sanitize(text); // 清理文本
      return <div className="docPreviewHtml mdPreview" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    return (
      <div className="filesMdPreviewPane">
        <MarkdownPreview md={text} kbId="documents" />
      </div>
    );
  }

  /** 如果文件类型可编辑，则显示编辑器 */
  if (isEditableKind(kind)) {
    return (
      <MdSourceEditor
        id="filesEditSource"
        value={text} // 设置文本
        onChange={onChange} // 设置变化
        showLineNumbers // 显示行号
        placeholder="编辑文件内容…" // 设置占位符
      />
    );
  }

  /** 如果文件类型不可编辑，则返回 null */
  return null;
}
