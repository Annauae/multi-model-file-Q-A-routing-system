import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeCombinedExtract } from "../src/services/fileProcessor.js";

describe("finalizeCombinedExtract", () => {
  it("merges multiple ranges into one markdown file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kr-merge-"));
    const filesRoot = path.join(root, "files");
    const modulesDir = path.join(filesRoot, "documents", "modules");
    fs.mkdirSync(modulesDir, { recursive: true });
    const partA = path.join(modulesDir, "merged_p1-2.md");
    const partB = path.join(modulesDir, "merged_p4-5.md");
    fs.writeFileSync(partA, "# A\npage1", "utf-8");
    fs.writeFileSync(partB, "# B\npage4", "utf-8");

    const result = finalizeCombinedExtract(
      filesRoot,
      "manual.pdf",
      [[1, 2], [4, 5]],
      true,
      [
        { label: "pages 1-2", md: "# A\npage1", modulePath: "documents/modules/merged_p1-2.md", absPath: partA },
        { label: "pages 4-5", md: "# B\npage4", modulePath: "documents/modules/merged_p4-5.md", absPath: partB },
      ],
      { timings: { total_ms: 10 }, tokens: { total_tokens: 0 } },
    );

    expect(result.path).toContain("merged_manual_p1-2_p4-5.md");
    expect(fs.existsSync(path.join(filesRoot, result.path))).toBe(true);
    expect(fs.existsSync(partA)).toBe(false);
    expect(fs.existsSync(partB)).toBe(false);
    expect(result.markdown).toContain("# A");
    expect(result.markdown).toContain("# B");
  });
});
