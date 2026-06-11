from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings
from app.faq_converter import write_reference_faq_file


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert structured reference knowledge.md to FAQ format (preserves images)."
    )
    parser.add_argument(
        "--source",
        default="files/agent_3/knowledge.md",
        help="Source markdown path (relative to DATA_ROOT or absolute)",
    )
    parser.add_argument(
        "--agent-id",
        type=int,
        default=3,
        help="Agent id for YAML frontmatter (0 = omit frontmatter)",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Do not write .bak before overwriting source",
    )

    args = parser.parse_args()
    settings = Settings.load()

    source = Path(args.source)
    if not source.is_absolute():
        source = (settings.data_root / source).resolve()

    out = write_reference_faq_file(
        source_path=source,
        agent_id=args.agent_id,
        backup=not args.no_backup,
    )
    lines = out.read_text(encoding="utf-8").splitlines()
    faq_count = sum(1 for ln in lines if ln.startswith("## Q:"))
    img_count = sum(1 for ln in lines if ln.strip().startswith("!["))
    print(f"[ok] {out}")
    print(f"faq_entries={faq_count} image_lines={img_count} total_lines={len(lines)}")


if __name__ == "__main__":
    main()
