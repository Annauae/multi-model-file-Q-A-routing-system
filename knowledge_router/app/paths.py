from __future__ import annotations

from pathlib import Path


def kb_folder_name(kb_id: str) -> str:
    return f"kb_{kb_id}"


def kb_dir_rel(kb_id: str) -> str:
    return f"files/{kb_folder_name(kb_id)}"


def questions_json_rel(kb_id: str) -> str:
    return f"{kb_dir_rel(kb_id)}/questions.json"


def kb_dir_path(files_root: Path, kb_id: str) -> Path:
    return (files_root / kb_folder_name(kb_id)).resolve()


def questions_json_path(files_root: Path, kb_id: str) -> Path:
    return (kb_dir_path(files_root, kb_id) / "questions.json").resolve()


def kb_assets_dir_path(files_root: Path, kb_id: str) -> Path:
    return (kb_dir_path(files_root, kb_id) / "assets").resolve()
