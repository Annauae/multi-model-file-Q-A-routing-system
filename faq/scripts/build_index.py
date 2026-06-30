from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import settings
from app.indexer import rebuild_index


def main() -> int:
    parser = argparse.ArgumentParser(description="Build FAQ RAG indexes")
    parser.add_argument("--rebuild", action="store_true", help="Rebuild SQLite and FAISS indexes")
    args = parser.parse_args()
    if not args.rebuild:
        print("Use --rebuild to rebuild FAQ indexes.")
        return 0
    print("[build_index] start rebuild", flush=True)
    meta = rebuild_index(settings)
    print("[build_index] done", flush=True)
    for key, value in meta.items():
        print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
