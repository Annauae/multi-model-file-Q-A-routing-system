"""
paths.py — 知识库文件路径约定（全项目路径计算的单一来源）

职责：
  统一管理「知识库 ID → 磁盘目录 / 相对路径」的映射规则，避免在 main.py、
  questions_store.py 等处散落硬编码的 "files/kb_1/..." 字符串。

磁盘布局（以 kb_id="1" 为例）：
  files/kb_1/
    questions.json    ← FAQ 问答数据（标准问题 + 变体 + 预存回答）
    assets/           ← 回答 Markdown 中引用的图片（如 assets/xxx.png）

与 config 的关系：
  files_root 来自 Settings.files_root（默认 {项目根}/files），
  本模块的 *path 函数在其下拼接 kb_{id} 子目录。

阅读顺序：建议作为后端第一个文件阅读（最底层、无业务依赖）。
"""

from __future__ import annotations

from pathlib import Path


def kb_folder_name(kb_id: str) -> str:
    """知识库在 files/ 下的目录名，例如 kb_id="1" → "kb_1"。"""
    return f"kb_{kb_id}"


def kb_dir_rel(kb_id: str) -> str:
    """知识库目录的相对路径（用于 JSON citations 等展示），例如 "files/kb_1"。"""
    return f"files/{kb_folder_name(kb_id)}"


def questions_file_rel(kb_id: str) -> str:
    """questions.json 的相对路径，例如 "files/kb_1/questions.json"。"""
    return f"{kb_dir_rel(kb_id)}/questions.json"


def kb_dir_path(files_root: Path, kb_id: str) -> Path:
    """
    知识库目录的绝对路径。
    例：files_root=.../files, kb_id=1 → .../files/kb_1
    """
    return (files_root / kb_folder_name(kb_id)).resolve()


def questions_file_path(files_root: Path, kb_id: str) -> Path:
    """
    questions.json 的绝对路径（QuestionsStore 读写 FAQ 的入口）。
    例：.../files/kb_1/questions.json
    """
    return (kb_dir_path(files_root, kb_id) / "questions.json").resolve()


def kb_assets_dir_path(files_root: Path, kb_id: str) -> Path:
    """
    知识库 assets 目录的绝对路径（回答内 ![](assets/xxx.png) 的图片存放处）。
    /preview-asset 接口在此目录下解析 ref。
    """
    return (kb_dir_path(files_root, kb_id) / "assets").resolve()
