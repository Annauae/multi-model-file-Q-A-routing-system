from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

from .config import Settings, settings


_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_HTML_IMG_RE = re.compile(r"<img\b[^>]*\bsrc=[\"']([^\"']+)[\"'][^>]*>", re.IGNORECASE)
_ALT_RE = re.compile(r"\balt=[\"']([^\"']*)[\"']", re.IGNORECASE)


@dataclass(frozen=True)
class ImageRef:
    alt: str
    src: str
    url: str
    exists: bool
    kind: str = "image"


def normalize_src(src: str) -> str:
    cleaned = unquote((src or "").strip())
    cleaned = cleaned.replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned


def image_url(src: str) -> str:
    clean = normalize_src(src)
    if clean.startswith("assets/"):
        return "/" + clean
    if clean.startswith("/assets/"):
        return clean
    return "/assets/" + Path(clean).name


def image_disk_path(src: str, cfg: Settings = settings) -> Path:
    clean = normalize_src(src)
    if clean.startswith("assets/"):
        return cfg.assets_dir / clean[len("assets/") :]
    if clean.startswith("/assets/"):
        return cfg.assets_dir / clean[len("/assets/") :]
    return cfg.assets_dir / Path(clean).name


def extract_image_refs(markdown: str, cfg: Settings = settings) -> list[ImageRef]:
    refs: list[ImageRef] = []
    seen: set[str] = set()

    for match in _MD_IMAGE_RE.finditer(markdown or ""):
        alt = (match.group(1) or "").strip()
        src = normalize_src(match.group(2))
        if not src or src in seen:
            continue
        seen.add(src)
        refs.append(
            ImageRef(
                alt=alt,
                src=src,
                url=image_url(src),
                exists=image_disk_path(src, cfg).is_file(),
                kind="markdown",
            )
        )

    for match in _HTML_IMG_RE.finditer(markdown or ""):
        tag = match.group(0)
        src = normalize_src(match.group(1))
        if not src or src in seen:
            continue
        seen.add(src)
        alt_match = _ALT_RE.search(tag)
        refs.append(
            ImageRef(
                alt=(alt_match.group(1).strip() if alt_match else ""),
                src=src,
                url=image_url(src),
                exists=image_disk_path(src, cfg).is_file(),
                kind="html",
            )
        )

    return refs


def refs_to_dicts(refs: list[ImageRef]) -> list[dict]:
    return [
        {
            "alt": ref.alt,
            "src": ref.src,
            "url": ref.url,
            "exists": ref.exists,
            "kind": ref.kind,
        }
        for ref in refs
    ]
