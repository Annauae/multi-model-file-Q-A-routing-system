import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    collectAssetRefsFromText,
    copyAssetRefsToDir,
    normalizeAssetRef,
    rewriteAssetPathsInText,
} from "../src/services/assetSync.js";
import { documentsAssetsDirPath, kbAssetsDirPath } from "../src/services/paths.js";

describe("assetSync", () => {
    it("normalizes asset refs", () => {
        expect(normalizeAssetRef("knowledge_p1.png")).toBe("assets/knowledge_p1.png");
        expect(normalizeAssetRef("assets/foo.png")).toBe("assets/foo.png");
        expect(normalizeAssetRef("/assets/foo.png")).toBe("assets/foo.png");
    });

    it("collects refs from markdown and html", () => {
        const md = "![a](assets/a.png)\n<img src=\"assets/b.png\">";
        expect(collectAssetRefsFromText(md).sort()).toEqual(["assets/a.png", "assets/b.png"]);
    });

    it("rewrites paths in text", () => {
        const out = rewriteAssetPathsInText("![x](knowledge.png)");
        expect(out).toContain("assets/knowledge.png");
    });

    it("copies assets to kb dir", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-sync-"));
        const docsAssets = documentsAssetsDirPath(root);
        fs.mkdirSync(docsAssets, { recursive: true });
        fs.writeFileSync(path.join(docsAssets, "test.png"), "png");
        const kbAssets = kbAssetsDirPath(root, "1");
        const n = copyAssetRefsToDir(root, ["assets/test.png"], kbAssets);
        expect(n).toBe(1);
        expect(fs.existsSync(path.join(kbAssets, "test.png"))).toBe(true);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
