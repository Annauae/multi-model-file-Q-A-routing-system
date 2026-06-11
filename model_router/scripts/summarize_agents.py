from __future__ import annotations

import json
from pathlib import Path


def main() -> None:
    data = json.loads(Path("config/agents.json").read_text(encoding="utf-8"))
    for i in range(1, 14):
        k = str(i)
        cfg = data.get(k, {}) if isinstance(data, dict) else {}
        status = cfg.get("status")
        files_dir = cfg.get("files_dir")
        files = cfg.get("files") or []
        rqs = cfg.get("route_questions") or []
        fs = cfg.get("file_summaries") or []
        ts = cfg.get("last_initialized_at")
        first = files[0] if isinstance(files, list) and files else ""
        print(k, status, files_dir, len(files) if isinstance(files, list) else -1, len(rqs) if isinstance(rqs, list) else -1, len(fs) if isinstance(fs, list) else -1, bool(ts), first)


if __name__ == "__main__":
    main()

