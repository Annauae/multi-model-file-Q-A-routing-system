"""知识库相关路径工具。

统一计算 kb 目录、questions.json、assets 目录在磁盘上的位置，避免路径拼接散落各处。
"""
from __future__ import annotations

from pathlib import Path


def kb_folder_name(kb_id: str) -> str:
    """知识库在 files 下的目录名，如 kb_id='1' -> 'kb_1'。"""
    return f"kb_{kb_id}"


def kb_dir_rel(kb_id: str) -> str:
    """知识库目录相对路径，如 'files/kb_1'。"""
    return f"files/{kb_folder_name(kb_id)}"


def questions_json_rel(kb_id: str) -> str:
    """questions.json 相对路径，如 'files/kb_1/questions.json'。"""
    return f"{kb_dir_rel(kb_id)}/questions.json"


def kb_dir_path(files_root: Path, kb_id: str) -> Path:
    """知识库根目录绝对路径：{files_root}/kb_{kb_id}。"""
    return (files_root / kb_folder_name(kb_id)).resolve()


def questions_json_path(files_root: Path, kb_id: str) -> Path:
    """FAQ 数据文件绝对路径：{files_root}/kb_{kb_id}/questions.json。"""
    return (kb_dir_path(files_root, kb_id) / "questions.json").resolve()


def kb_assets_dir_path(files_root: Path, kb_id: str) -> Path:
    """知识库插图等资源目录：{files_root}/kb_{kb_id}/assets。"""
    return (kb_dir_path(files_root, kb_id) / "assets").resolve()
