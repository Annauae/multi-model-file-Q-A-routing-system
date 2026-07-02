/** Document type registry for file management. */

export const ALLOWED_SOURCE_EXTENSIONS = [
    ".pdf",
    ".md",
    ".markdown",
    ".txt",
    ".docx",
    ".html",
    ".htm",
    ".json",
    ".xlsx",
    ".xls",
    ".csv",
];

const EXT_TO_FORMAT = {
    ".pdf": "pdf",
    ".md": "md",
    ".markdown": "md",
    ".txt": "txt",
    ".docx": "docx",
    ".html": "html",
    ".htm": "html",
    ".json": "json",
    ".xlsx": "xlsx",
    ".xls": "xls",
    ".csv": "csv",
};

const SOURCE_KIND_BY_EXT = {
    ".pdf": "source_pdf",
    ".md": "source_md",
    ".markdown": "source_md",
    ".txt": "source_txt",
    ".docx": "source_docx",
    ".html": "source_html",
    ".htm": "source_html",
    ".json": "source_json",
    ".xlsx": "source_xlsx",
    ".xls": "source_xls",
    ".csv": "source_csv",
};

const CAPABILITIES = {
    source_pdf: {
        editable: false,
        previewOnly: true,
        needsConvertForEdit: true,
        directQuestionGen: false,
        canConvert: true,
        convertKind: "pdf_pages",
        defaultVlmRefine: false,
        isTextFile: false,
    },
    source_md: {
        editable: true,
        previewOnly: false,
        needsConvertForEdit: false,
        directQuestionGen: true,
        canConvert: true,
        convertKind: "line_range",
        defaultVlmRefine: false,
        isTextFile: true,
    },
    source_txt: {
        editable: true,
        previewOnly: false,
        needsConvertForEdit: false,
        directQuestionGen: true,
        canConvert: true,
        convertKind: "line_range",
        defaultVlmRefine: false,
        isTextFile: true,
    },
    source_html: {
        editable: true,
        previewOnly: false,
        needsConvertForEdit: false,
        directQuestionGen: true,
        canConvert: true,
        convertKind: "line_range",
        defaultVlmRefine: true,
        isTextFile: true,
    },
    source_json: {
        editable: true,
        previewOnly: false,
        needsConvertForEdit: false,
        directQuestionGen: true,
        canConvert: true,
        convertKind: "line_range",
        defaultVlmRefine: false,
        isTextFile: true,
    },
    source_docx: {
        editable: false,
        previewOnly: true,
        needsConvertForEdit: true,
        directQuestionGen: true,
        canConvert: true,
        convertKind: "whole_doc",
        defaultVlmRefine: true,
        isTextFile: false,
    },
    source_xlsx: {
        editable: false,
        previewOnly: true,
        needsConvertForEdit: true,
        directQuestionGen: false,
        canConvert: true,
        convertKind: "sheet_rows",
        defaultVlmRefine: true,
        isTextFile: false,
    },
    source_xls: {
        editable: false,
        previewOnly: true,
        needsConvertForEdit: true,
        directQuestionGen: false,
        canConvert: true,
        convertKind: "sheet_rows",
        defaultVlmRefine: true,
        isTextFile: false,
    },
    source_csv: {
        editable: false,
        previewOnly: true,
        needsConvertForEdit: true,
        directQuestionGen: false,
        canConvert: true,
        convertKind: "sheet_rows",
        defaultVlmRefine: true,
        isTextFile: false,
    },
    module_md: {
        editable: true,
        previewOnly: false,
        needsConvertForEdit: false,
        directQuestionGen: true,
        canConvert: false,
        convertKind: null,
        defaultVlmRefine: false,
        isTextFile: true,
    },
};

export function getExtension(filename) {
    const lower = String(filename || "").toLowerCase();
    for (const ext of ALLOWED_SOURCE_EXTENSIONS.sort((a, b) => b.length - a.length)) {
        if (lower.endsWith(ext))
            return ext;
    }
    if (lower.endsWith(".md"))
        return ".md";
    return "";
}

export function isAllowedSourceExtension(filename) {
    return Boolean(getExtension(filename));
}

export function formatFromFilename(filename) {
    return EXT_TO_FORMAT[getExtension(filename)] || "";
}

export function fileKind(name, parent) {
    const lower = String(name || "").toLowerCase();
    if (parent === "sources") {
        const ext = getExtension(lower);
        return SOURCE_KIND_BY_EXT[ext] || null;
    }
    if (parent === "modules" && lower.endsWith(".md"))
        return "module_md";
    return null;
}

export function getCapabilities(kind) {
    return CAPABILITIES[kind] || null;
}

export function capabilitiesForKind(kind) {
    const caps = getCapabilities(kind);
    if (!caps)
        return null;
    return {
        editable: caps.editable,
        preview_only: caps.previewOnly,
        needs_convert_for_edit: caps.needsConvertForEdit,
        direct_question_gen: caps.directQuestionGen,
        can_convert: caps.canConvert,
        convert_kind: caps.convertKind,
        default_vlm_refine: caps.defaultVlmRefine,
    };
}

export function isEditableKind(kind) {
    return getCapabilities(kind)?.editable === true;
}

export function isTextSourceKind(kind) {
    return getCapabilities(kind)?.isTextFile === true;
}

export function kindLabel(kind) {
    const labels = {
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

export function listCapabilitiesPayload() {
    return {
        extensions: ALLOWED_SOURCE_EXTENSIONS,
        kinds: Object.fromEntries(
            Object.entries(CAPABILITIES).map(([k, v]) => [k, capabilitiesForKind(k)]),
        ),
    };
}
