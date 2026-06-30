from __future__ import annotations

import hashlib
import html
import re
from typing import Iterable


_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_PUNCT_RE = re.compile(r"[\s\W_]+", re.UNICODE)


def stable_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def strip_markdown(text: str) -> str:
    """Convert answer markdown/html to compact plain text for indexing."""
    s = text or ""
    s = _MD_IMAGE_RE.sub(lambda m: f"{m.group(1)} {m.group(2)}", s)
    s = re.sub(r"`([^`]+)`", r"\1", s)
    s = re.sub(r"[*_#>|~\-]+", " ", s)
    s = _HTML_TAG_RE.sub(" ", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def answer_summary(answer: str, max_chars: int = 900) -> str:
    text = strip_markdown(answer)
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def normalize_query(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def char_ngrams(text: str, min_n: int = 2, max_n: int = 3) -> list[str]:
    cleaned = _PUNCT_RE.sub("", (text or "").lower())
    tokens: list[str] = []
    for n in range(min_n, max_n + 1):
        if len(cleaned) < n:
            continue
        tokens.extend(cleaned[i : i + n] for i in range(0, len(cleaned) - n + 1))
    # Add alnum words so English model/menu names still work.
    tokens.extend(re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", (text or "").lower()))
    return tokens


def keyword_text(texts: Iterable[str]) -> str:
    toks: list[str] = []
    for text in texts:
        toks.extend(char_ngrams(text))
    return " ".join(toks)


def clip_text(text: str, limit: int) -> str:
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    return s[: limit - 1].rstrip() + "…"
