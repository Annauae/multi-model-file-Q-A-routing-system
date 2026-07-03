import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { convertExcelToMarkdown, convertHtmlToMarkdown, extractTextLinesFromContent, listExcelSheets } from "../src/services/documentConverters.js";

describe("documentConverters", () => {
    it("converts html to markdown", () => {
        const { markdown } = convertHtmlToMarkdown("<h1>Title</h1><p>Body</p>");
        expect(markdown).toContain("Title");
        expect(markdown).toContain("Body");
    });

    it("pretty prints json lines", () => {
        const lines = extractTextLinesFromContent('{"a":1}', "source_json");
        expect(lines.join("\n")).toContain('"a"');
    });

    it("csv file roundtrip path", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kr-csv-"));
        const csvPath = path.join(tmp, "t.csv");
        fs.writeFileSync(csvPath, "a,b\n1,2\n", "utf-8");
        expect(fs.existsSync(csvPath)).toBe(true);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("reads xlsx sheets and converts to markdown", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kr-xlsx-"));
        const xlsxPath = path.join(tmp, "sample.xlsx");
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["A", "B"], [1, 2]]), "Sheet1");
        XLSX.writeFile(wb, xlsxPath);
        expect(listExcelSheets(xlsxPath)).toEqual(["Sheet1"]);
        const { markdown, preview_html } = convertExcelToMarkdown(xlsxPath, { rowStart: 1, rowEnd: 2 });
        expect(markdown).toContain("A");
        expect(markdown).toContain("1");
        expect(preview_html).toContain("<table");
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});
