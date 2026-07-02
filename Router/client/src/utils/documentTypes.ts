export const ALLOWED_SOURCE_EXTENSIONS = [
  ".pdf", ".md", ".markdown", ".txt", ".docx", ".html", ".htm", ".json", ".xlsx", ".xls", ".csv",
];

export const UPLOAD_ACCEPT = ALLOWED_SOURCE_EXTENSIONS.join(",");

export interface DocCapabilities {
  editable?: boolean;
  preview_only?: boolean;
  needs_convert_for_edit?: boolean;
  direct_question_gen?: boolean;
  can_convert?: boolean;
  convert_kind?: string | null;
  default_vlm_refine?: boolean;
}

export function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    source_pdf: "PDF",
    source_md: "MD",
    source_txt: "TXT",
    source_docx: "DOCX",
    source_html: "HTML",
    source_json: "JSON",
    source_xlsx: "XLSX",
    source_xls: "XLS",
    source_csv: "CSV",
    module_md: "MD",
  };
  return labels[kind] || "FILE";
}

export function isPreviewOnlyKind(kind: string): boolean {
  return kind === "source_pdf" || kind === "source_docx" || kind === "source_xlsx" || kind === "source_xls" || kind === "source_csv";
}

export function isEditableKind(kind: string): boolean {
  return kind === "source_md" || kind === "module_md" || kind === "source_txt" || kind === "source_html" || kind === "source_json";
}

export function canConvertKind(kind: string): boolean {
  return !["module_md"].includes(kind) && kind !== "source_json";
}

export function canQuestionGenKind(kind: string): boolean {
  return ["source_md", "module_md", "source_txt", "source_docx", "source_html", "source_json"].includes(kind);
}

export function defaultVlmRefineKind(kind: string): boolean {
  return ["source_docx", "source_xlsx", "source_xls", "source_csv", "source_html"].includes(kind);
}

export function convertKindFor(kind: string): string {
  if (kind === "source_pdf") return "pdf_pages";
  if (kind === "source_docx") return "whole_doc";
  if (kind === "source_xlsx" || kind === "source_xls" || kind === "source_csv") return "sheet_rows";
  return "line_range";
}
