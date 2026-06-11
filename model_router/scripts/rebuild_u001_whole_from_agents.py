from __future__ import annotations

import re
from pathlib import Path

_MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_FRONTMATTER_RE = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)


def _strip_frontmatter(text: str) -> str:
    return _FRONTMATTER_RE.sub("", text, count=1).lstrip("\n")


def _agent_to_plain(faq_body: str) -> str:
    """Turn FAQ knowledge back into plain markdown (for u001_whole source)."""
    text = faq_body.strip()
    if not text:
        return ""

    blocks = re.split(r"\n(?=## Q:)", text)
    out_lines: list[str] = []

    for block in blocks:
        block = block.strip()
        if not block:
            continue
        block = re.sub(r"^## Q:\s*", "", block, count=1)
        if not block:
            continue

        q_end = block.find("\n\nA:")
        if q_end == -1:
            q_end = block.find("\nA:")
        if q_end != -1:
            question = block[:q_end].strip()
            rest = block[q_end:].lstrip("\n")
            if rest.startswith("A:"):
                rest = rest[2:].lstrip()
            if question:
                out_lines.append(question)
            body = rest
        else:
            body = block

        for line in body.splitlines():
            line = line.rstrip()
            if not line:
                out_lines.append("")
                continue
            m = _MD_IMG_RE.search(line)
            if m:
                ref = m.group(2).strip()
                if ref.startswith("../assets/"):
                    ref = ref[3:]
                elif ref.startswith("../"):
                    ref = ref[3:]
                line = f"![{m.group(1)}]({ref})"
            out_lines.append(line)

    return "\n".join(out_lines).strip()


def rebuild_u001_whole(*, files_root: Path, out_path: Path) -> None:
    parts: list[str] = []
    for agent_id in range(1, 14):
        path = files_root / f"agent_{agent_id}" / "knowledge.md"
        if not path.is_file():
            continue
        plain = _agent_to_plain(_strip_frontmatter(path.read_text(encoding="utf-8")))
        if plain:
            parts.append(plain)

    header = (
        "---\n"
        "source_file: ZfcRGPRC_(Sc)12_入门两章.pdf\n"
        "outline_path: \n"
        "unit_id: whole\n"
        "page_start: 1\n"
        "page_end: 55\n"
        "---\n\n"
    )
    out_path.write_text(header + "\n\n".join(parts) + "\n", encoding="utf-8")


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    files_root = root / "files"
    rebuild_u001_whole(files_root=files_root, out_path=files_root / "u001_whole.md")
    print(f"restored {files_root / 'u001_whole.md'}")
