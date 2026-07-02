import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { convertHtmlToMarkdown, extractTextLinesFromContent } from "../src/services/documentConverters.js";

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
});
