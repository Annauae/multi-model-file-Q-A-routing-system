import fs from "node:fs";
import path from "node:path";

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_IMG_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
const ALT_RE = /\balt=["']([^"']*)["']/i;

export function normalizeSrc(src) {
    let cleaned = decodeURIComponent((src || "").trim());
    cleaned = cleaned.replace(/\\/g, "/");
    while (cleaned.startsWith("./"))
        cleaned = cleaned.slice(2);
    return cleaned;
}

export function imageUrl(src) {
    const clean = normalizeSrc(src);
    if (clean.startsWith("assets/"))
        return `/${clean}`;
    if (clean.startsWith("/assets/"))
        return clean;
    return `/assets/${path.basename(clean)}`;
}

export function imageDiskPath(src, assetsDir) {
    const clean = normalizeSrc(src);
    if (clean.startsWith("assets/"))
        return path.join(assetsDir, clean.slice("assets/".length));
    if (clean.startsWith("/assets/"))
        return path.join(assetsDir, clean.slice("/assets/".length));
    return path.join(assetsDir, path.basename(clean));
}

export function extractImageRefs(markdown, assetsDir) {
    const refs = [];
    const seen = new Set();
    const text = markdown || "";

    for (const match of text.matchAll(MD_IMAGE_RE)) {
        const alt = (match[1] || "").trim();
        const src = normalizeSrc(match[2]);
        if (!src || seen.has(src))
            continue;
        seen.add(src);
        const disk = imageDiskPath(src, assetsDir);
        refs.push({
            alt,
            src,
            url: imageUrl(src),
            exists: fs.existsSync(disk),
            kind: "markdown",
        });
    }

    for (const match of text.matchAll(HTML_IMG_RE)) {
        const tag = match[0];
        const src = normalizeSrc(match[1]);
        if (!src || seen.has(src))
            continue;
        seen.add(src);
        const altMatch = ALT_RE.exec(tag);
        const disk = imageDiskPath(src, assetsDir);
        refs.push({
            alt: altMatch ? altMatch[1].trim() : "",
            src,
            url: imageUrl(src),
            exists: fs.existsSync(disk),
            kind: "html",
        });
    }

    return refs;
}

export function refsToDicts(refs) {
    return refs.map((ref) => ({
        alt: ref.alt,
        src: ref.src,
        url: ref.url,
        exists: ref.exists,
        kind: ref.kind,
    }));
}
