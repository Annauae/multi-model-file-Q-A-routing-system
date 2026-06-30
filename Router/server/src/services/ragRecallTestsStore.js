import fs from "node:fs";
import path from "node:path";

function emptyDocument() {
    return { items: [] };
}

export class RagRecallTestsStore {
    filePath;

    constructor(filePath) {
        this.filePath = filePath;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(emptyDocument(), null, 2), "utf-8");
        }
    }

    static open(filePath) {
        return new RagRecallTestsStore(filePath);
    }

    getDocument() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            const items = Array.isArray(raw.items) ? raw.items : [];
            return { items };
        }
        catch {
            return { items: [] };
        }
    }

    replaceAll(body) {
        const items = Array.isArray(body?.items) ? body.items : [];
        const doc = { items };
        fs.writeFileSync(this.filePath, JSON.stringify(doc, null, 2), "utf-8");
        return doc;
    }
}
