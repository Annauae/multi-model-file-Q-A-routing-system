"""Migrate agent folders to md/ + assets/png/ layout and create default router."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_MD_IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def _rewrite_image_ref(ref: str) -> str:
    ref = (ref or "").strip()
    if not ref or ref.startswith(("http://", "https://", "data:")):
        return ref
    name = Path(ref.replace("\\", "/")).name
    if ref.startswith("assets/png/"):
        return ref
    return f"assets/png/{name}"


def _rewrite_md_images(text: str) -> str:
    def repl(m: re.Match) -> str:
        old = m.group(0)
        ref = m.group(1)
        new_ref = _rewrite_image_ref(ref)
        if new_ref == ref:
            return old
        return old.replace(f"({ref})", f"({new_ref})")

    return _MD_IMG_RE.sub(repl, text)


def _resolve_image_src(project_root: Path, agent_dir: Path, ref: str) -> Path | None:
    ref = (ref or "").strip()
    if not ref or ref.startswith(("http://", "https://", "data:")):
        return None
    candidates = [
        agent_dir / ref,
        agent_dir / ref.lstrip("/"),
        project_root / "files" / ref.lstrip("/"),
        project_root / ref.lstrip("/"),
    ]
    if ref.startswith("assets/"):
        candidates.append(project_root / "files" / ref)
    name = Path(ref.replace("\\", "/")).name
    candidates.append(project_root / "files" / "assets" / name)
    seen: set[Path] = set()
    for p in candidates:
        try:
            resolved = p.resolve()
        except Exception:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_file():
            return resolved
    return None


def migrate_agent(project_root: Path, agent_id: str, *, dry_run: bool = False) -> dict:
    agent_dir = project_root / "files" / f"agent_{agent_id}"
    if not agent_dir.is_dir():
        return {"agent_id": agent_id, "status": "missing_dir"}

    md_dir = agent_dir / "md"
    png_dir = agent_dir / "assets" / "png"
    moved_md: list[str] = []
    copied_images: list[str] = []

    md_files = [
        p
        for p in sorted(agent_dir.iterdir(), key=lambda x: x.name.lower())
        if p.is_file() and p.suffix.lower() == ".md" and p.name.lower() != "prompt.md"
    ]
    if md_dir.is_dir():
        md_files.extend(
            p for p in sorted(md_dir.iterdir(), key=lambda x: x.name.lower()) if p.is_file() and p.suffix.lower() == ".md"
        )

    if not md_files:
        return {"agent_id": agent_id, "status": "no_md"}

    if not dry_run:
        md_dir.mkdir(parents=True, exist_ok=True)
        png_dir.mkdir(parents=True, exist_ok=True)

    new_file_paths: list[str] = []
    seen_names: set[str] = set()

    for src in md_files:
        if src.parent == md_dir:
            rel = src.relative_to(project_root).as_posix()
            new_file_paths.append(rel)
            text = src.read_text(encoding="utf-8", errors="ignore")
        else:
            dest = md_dir / src.name
            if dest.exists() and dest.resolve() != src.resolve():
                stem = src.stem
                n = 2
                while (md_dir / f"{stem}_{n}.md").exists():
                    n += 1
                dest = md_dir / f"{stem}_{n}.md"
            text = src.read_text(encoding="utf-8", errors="ignore")
            if not dry_run:
                dest.write_text(text, encoding="utf-8")
                if src.resolve() != dest.resolve():
                    src.unlink(missing_ok=True)
            moved_md.append(dest.name)
            rel = dest.relative_to(project_root).as_posix()
            new_file_paths.append(rel)

        refs = _MD_IMG_RE.findall(text)
        for ref in refs:
            src_img = _resolve_image_src(project_root, agent_dir, ref)
            if not src_img:
                continue
            dest_name = src_img.name
            if dest_name in seen_names:
                continue
            seen_names.add(dest_name)
            if not dry_run:
                shutil.copy2(src_img, png_dir / dest_name)
            copied_images.append(dest_name)

        new_text = _rewrite_md_images(text)
        target = project_root / new_file_paths[-1]
        if not dry_run and target.is_file():
            target.write_text(new_text, encoding="utf-8")

    return {
        "agent_id": agent_id,
        "status": "ok",
        "md_files": moved_md,
        "images": copied_images,
        "files": new_file_paths,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate agents to md/ + assets/png/ layout")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--data-root", type=str, default=str(ROOT))
    args = parser.parse_args()

    data_root = Path(args.data_root).resolve()
    agents_path = data_root / "config" / "agents.json"
    routers_path = data_root / "config" / "routers.json"

    agents = json.loads(agents_path.read_text(encoding="utf-8"))
    if not isinstance(agents, dict):
        raise SystemExit("agents.json must be object")

    agent_ids = sorted(agents.keys(), key=lambda x: (not str(x).isdigit(), int(x) if str(x).isdigit() else x))
    results = []
    for aid in agent_ids:
        r = migrate_agent(data_root, aid, dry_run=args.dry_run)
        results.append(r)
        if r.get("status") == "ok":
            agents[aid]["router_id"] = "1"
            if r.get("files"):
                agents[aid]["files"] = r["files"]
            print(f"agent_{aid}: md={len(r.get('md_files', []))} images={len(r.get('images', []))}")
        else:
            agents[aid]["router_id"] = agents[aid].get("router_id") or "1"
            print(f"agent_{aid}: {r.get('status')}")

    if not args.dry_run:
        agents_path.write_text(json.dumps(agents, ensure_ascii=False, indent=2), encoding="utf-8")

        routers = {
            "1": {
                "name": "总Agent_1",
                "router_prompt": "",
                "status": "initialized",
                "agent_ids": agent_ids,
                "source_files": ["files/ZfcRGPRC_(Sc)12.pdf"],
                "split_ranges": [],
                "created_at": "2026-06-12T00:00:00Z",
                "updated_at": "2026-06-12T00:00:00Z",
            }
        }
        routers_path.write_text(json.dumps(routers, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote {routers_path}")
        print(f"Updated {agents_path}")


if __name__ == "__main__":
    main()
