import { describe, expect, it } from "vitest";
import { collectImageRefsFromMarkdown } from "../src/services/documentConverters.js";

describe("documentVlmRefine helpers", () => {
    it("collects image refs from markdown", () => {
        const refs = collectImageRefsFromMarkdown("text\n![img](assets/abc.png)\n");
        expect(refs).toEqual(["assets/abc.png"]);
    });
});
