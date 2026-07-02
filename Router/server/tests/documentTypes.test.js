import { describe, expect, it } from "vitest";
import {
    ALLOWED_SOURCE_EXTENSIONS,
    capabilitiesForKind,
    fileKind,
    formatFromFilename,
    isAllowedSourceExtension,
    isEditableKind,
} from "../src/services/documentTypes.js";

describe("documentTypes", () => {
    it("allows extended source extensions", () => {
        expect(ALLOWED_SOURCE_EXTENSIONS).toContain(".docx");
        expect(ALLOWED_SOURCE_EXTENSIONS).toContain(".xlsx");
        expect(ALLOWED_SOURCE_EXTENSIONS).toContain(".csv");
        expect(isAllowedSourceExtension("manual.docx")).toBe(true);
        expect(isAllowedSourceExtension("readme.markdown")).toBe(true);
        expect(isAllowedSourceExtension("bad.exe")).toBe(false);
    });

    it("maps file kinds in sources", () => {
        expect(fileKind("a.pdf", "sources")).toBe("source_pdf");
        expect(fileKind("a.docx", "sources")).toBe("source_docx");
        expect(fileKind("a.txt", "sources")).toBe("source_txt");
        expect(fileKind("a.md", "modules")).toBe("module_md");
    });

    it("exposes capabilities", () => {
        expect(capabilitiesForKind("source_docx")?.direct_question_gen).toBe(true);
        expect(capabilitiesForKind("source_docx")?.editable).toBe(false);
        expect(capabilitiesForKind("source_xlsx")?.direct_question_gen).toBe(false);
        expect(isEditableKind("source_txt")).toBe(true);
        expect(formatFromFilename("x.csv")).toBe("csv");
    });
});
