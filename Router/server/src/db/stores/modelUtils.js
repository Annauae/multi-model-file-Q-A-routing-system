export const SLOTS = ["match", "import", "pdf_vlm"];
export const MASK = "***";

export function parseEnableThinking(val) {
    if (val == null)
        return null;
    if (typeof val === "boolean")
        return val;
    if (typeof val === "number")
        return Boolean(val);
    if (typeof val === "string") {
        const s = val.trim().toLowerCase();
        if (["1", "true", "yes"].includes(s))
            return true;
        if (["0", "false", "no"].includes(s))
            return false;
    }
    return null;
}
