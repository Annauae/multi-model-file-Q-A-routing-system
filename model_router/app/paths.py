from __future__ import annotations

"""Central path helpers for router-scoped agent storage."""

from pathlib import Path


def source_files_root() -> str:
    """Shared source PDF/Markdown uploads."""
    return "files/root"


def router_dir(router_id: str) -> str:
    return f"files/router_{router_id}"


def router_agents_config_rel(router_id: str) -> str:
    return f"{router_dir(router_id)}/agents.json"


def agent_files_dir(router_id: str, agent_id: str) -> str:
    return f"{router_dir(router_id)}/agent_{agent_id}"


def agent_folder_name(agent_id: str) -> str:
    return f"agent_{agent_id}"


def router_folder_name(router_id: str) -> str:
    return f"router_{router_id}"


def agents_config_path(files_root: Path, router_id: str) -> Path:
    return (files_root / router_folder_name(router_id) / "agents.json").resolve()


def agent_dir_path(files_root: Path, router_id: str, agent_id: str) -> Path:
    return (files_root / router_folder_name(router_id) / agent_folder_name(agent_id)).resolve()


def source_root_path(files_root: Path) -> Path:
    return (files_root / "root").resolve()
