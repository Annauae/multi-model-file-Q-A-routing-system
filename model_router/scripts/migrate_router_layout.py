#!/usr/bin/env python3
"""Migrate to per-router layout: files/router_{id}/agents.json + agent dirs, files/root sources, assets/."""
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List

_MD_IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def _rewrite_md_images(text: str) -> str:
    def repl(m: re.Match) -> str:
        ref = (m.group(1) or "").strip()
        if not ref or ref.startswith(("http://", "https://", "data:")):
            return m.group(0)
        name = Path(ref.replace("\\", "/")).name
        new_ref = f"assets/{name}"
        return m.group(0).replace(f"({ref})", f"({new_ref})")

    return _MD_IMG_RE.sub(repl, text)


def _rewrite_path(p: str, *, router_id: str) -> str:
    p = (p or "").replace("\\", "/")
    if p.startswith(f"files/router_{router_id}/"):
        return p
    if p.startswith("files/agent_"):
        rest = p[len("files/") :]
        return f"files/router_{router_id}/{rest}"
    return p


def migrate(data_root: Path, *, dry_run: bool = False) -> None:
    files_root = data_root / "files"
    config_agents = data_root / "config" / "agents.json"
    routers_path = data_root / "config" / "routers.json"

    root_dir = files_root / "root"
    if not dry_run:
        root_dir.mkdir(parents=True, exist_ok=True)

    # Move source PDFs/md at files root → files/root/
    for item in list(files_root.iterdir()) if files_root.is_dir() else []:
        if not item.is_file():
            continue
        if item.suffix.lower() in {".pdf", ".md"}:
            dest = root_dir / item.name
            print(f"move source {item.name} -> files/root/")
            if not dry_run:
                if dest.exists():
                    dest.unlink()
                shutil.move(str(item), str(dest))

    routers: Dict[str, Any] = {}
    if routers_path.is_file():
        routers = json.loads(routers_path.read_text(encoding="utf-8"))

    # Default router 1 if missing
    if "1" not in routers:
        routers["1"] = {
            "name": "总Agent_1",
            "router_prompt": "",
            "status": "initialized",
            "agent_ids": [],
            "source_files": [],
            "split_ranges": [],
        }

    # Load legacy global agents.json
    legacy_agents: Dict[str, Any] = {}
    if config_agents.is_file():
        legacy_agents = json.loads(config_agents.read_text(encoding="utf-8"))
        if not isinstance(legacy_agents, dict):
            legacy_agents = {}

    # Group agents by router_id
    by_router: Dict[str, Dict[str, Any]] = {}
    for aid, cfg in legacy_agents.items():
        if not isinstance(cfg, dict):
            continue
        rid = str(cfg.get("router_id") or "1").strip() or "1"
        by_router.setdefault(rid, {})[aid] = cfg

    # Move flat agent_* dirs into router_1 if not already grouped
    for entry in list(files_root.iterdir()) if files_root.is_dir() else []:
        if entry.is_dir() and entry.name.startswith("agent_"):
            aid = entry.name.replace("agent_", "", 1)
            rid = "1"
            if aid in legacy_agents:
                rid = str(legacy_agents[aid].get("router_id") or "1").strip() or "1"
            router_agent = files_root / f"router_{rid}" / entry.name
            if router_agent.exists():
                continue
            print(f"move {entry.name} -> router_{rid}/{entry.name}")
            if not dry_run:
                router_agent.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(entry), str(router_agent))

    for rid, router_cfg in routers.items():
        router_dir = files_root / f"router_{rid}"
        agents_path = router_dir / "agents.json"
        agents = by_router.get(rid, {})
        if not agents and agents_path.is_file():
            agents = json.loads(agents_path.read_text(encoding="utf-8"))

        # Update each agent config + on-disk layout
        for aid, cfg in list(agents.items()):
            if not isinstance(cfg, dict):
                continue
            agent_dir = router_dir / f"agent_{aid}"
            new_files_dir = f"files/router_{rid}/agent_{aid}"
            cfg["files_dir"] = new_files_dir
            cfg["router_id"] = rid

            # assets/png -> assets
            png_dir = agent_dir / "assets" / "png"
            assets_dir = agent_dir / "assets"
            if png_dir.is_dir():
                assets_dir.mkdir(parents=True, exist_ok=True)
                for img in png_dir.iterdir():
                    if img.is_file():
                        dest = assets_dir / img.name
                        print(f"  {aid}: image {img.name} -> assets/")
                        if not dry_run:
                            if dest.exists():
                                dest.unlink()
                            shutil.move(str(img), str(dest))
                if not dry_run and png_dir.exists() and not any(png_dir.iterdir()):
                    png_dir.rmdir()

            # Rewrite md refs
            for md in list(agent_dir.rglob("*.md")):
                text = md.read_text(encoding="utf-8", errors="ignore")
                new_text = _rewrite_md_images(text)
                if new_text != text:
                    print(f"  rewrite images in {md.relative_to(files_root)}")
                    if not dry_run:
                        md.write_text(new_text, encoding="utf-8")

            # Remove legacy root-level md if md/ copy exists
            md_sub = agent_dir / "md"
            if md_sub.is_dir():
                for legacy_md in agent_dir.glob("knowledge*.md"):
                    if legacy_md.is_file():
                        print(f"  remove legacy {legacy_md.relative_to(files_root)}")
                        if not dry_run:
                            legacy_md.unlink()

            files_list = cfg.get("files") if isinstance(cfg.get("files"), list) else []
            cfg["files"] = [_rewrite_path(str(f), router_id=rid) for f in files_list if f]
            agents[aid] = cfg

        if agents:
            print(f"write router_{rid}/agents.json ({len(agents)} agents)")
            if not dry_run:
                router_dir.mkdir(parents=True, exist_ok=True)
                agents_path.write_text(json.dumps(agents, ensure_ascii=False, indent=2), encoding="utf-8")

        # Update router source_files
        src_files: List[str] = []
        for sf in router_cfg.get("source_files") or []:
            sf_str = str(sf).replace("\\", "/")
            name = Path(sf_str).name
            new_path = f"files/root/{name}"
            src_files.append(new_path)
        router_cfg["source_files"] = src_files
        ids = list(router_cfg.get("agent_ids") or [])
        for aid in agents:
            if aid not in ids:
                ids.append(aid)
        router_cfg["agent_ids"] = ids

    if not dry_run:
        routers_path.write_text(json.dumps(routers, ensure_ascii=False, indent=2), encoding="utf-8")
        # Clear legacy global agents.json (keep empty stub)
        config_agents.write_text("{}\n", encoding="utf-8")

    # Remove global files/assets
    global_assets = files_root / "assets"
    if global_assets.is_dir():
        print(f"remove legacy {global_assets.relative_to(data_root)}")
        if not dry_run:
            shutil.rmtree(global_assets)

    print("migration done")


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate to per-router agents.json layout")
    parser.add_argument("--data-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    migrate(args.data_root.resolve(), dry_run=args.dry_run)


if __name__ == "__main__":
    main()
