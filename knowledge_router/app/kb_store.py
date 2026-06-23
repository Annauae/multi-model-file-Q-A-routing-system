"""
kb_store.py — 知识库元数据持久化（config/knowledge_bases.json）

职责：
  管理「知识库」这一层的配置，与 FAQ 内容（questions.json）分离：
    - name、match_prompt（自定义匹配提示词）、status、时间戳
  不负责 FAQ 条目 CRUD（那是 questions_store.py）

线程安全：
  所有读写持 _lock，内存 _cache 与磁盘 JSON 同步写回。

阅读顺序：第 4 个（在 questions_store 之前，理解 kb 与 questions 两层数据）
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


def _now_iso() -> str:
    """UTC ISO8601 时间戳，用于 created_at / updated_at。"""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class KbStore:
    """
    knowledge_bases.json 的读写门面。
    结构：{ "1": { name, match_prompt, status, created_at, updated_at }, ... }
    """

    path: Path
    _lock: threading.Lock
    _cache: Dict[str, Dict[str, Any]]

    @staticmethod
    def open(path: Path) -> "KbStore":
        """打开或初始化 JSON 文件，载入内存缓存。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text("{}", encoding="utf-8")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeError("knowledge_bases.json 结构必须是 JSON object")
        return KbStore(path=path, _lock=threading.Lock(), _cache=data)

    def _save(self) -> None:
        """将 _cache 写回磁盘。"""
        self.path.write_text(json.dumps(self._cache, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_all(self) -> Dict[str, Dict[str, Any]]:
        """返回所有知识库配置的浅拷贝。"""
        with self._lock:
            return {kid: dict(v) for kid, v in self._cache.items() if isinstance(v, dict)}

    def get(self, kb_id: str) -> Optional[Dict[str, Any]]:
        """按 kb_id 取单条配置；不存在返回 None。"""
        with self._lock:
            cfg = self._cache.get(kb_id)
            return dict(cfg) if isinstance(cfg, dict) else None

    def next_available_kb_id(self) -> str:
        """分配下一个未使用的数字 ID（1, 2, 3, ...）。"""
        with self._lock:
            used: set[int] = set()
            for kid in self._cache:
                if str(kid).isdigit():
                    used.add(int(kid))
            n = 1
            while n in used:
                n += 1
            return str(n)

    def create_kb(self, *, kb_id: str, name: str) -> Dict[str, Any]:
        """新建知识库元数据条目（还需 main.py 创建 files/kb_{id}/ 目录）。"""
        with self._lock:
            if kb_id in self._cache:
                raise ValueError("kb_id 已存在")
            now = _now_iso()
            cfg: Dict[str, Any] = {
                "name": name,
                "match_prompt": "",
                "status": "ready",
                "created_at": now,
                "updated_at": now,
            }
            self._cache[kb_id] = cfg
            self._save()
            return dict(cfg)

    def delete_kb(self, *, kb_id: str) -> Dict[str, Any]:
        """从 JSON 删除知识库元数据（磁盘 files/kb_{id}/ 由 main.py 另行删除）。"""
        with self._lock:
            cfg = self._cache.get(kb_id)
            if not isinstance(cfg, dict):
                raise KeyError("kb_id 不存在")
            del self._cache[kb_id]
            self._save()
            return dict(cfg)

    def rename_kb(self, *, kb_id: str, name: str) -> Dict[str, Any]:
        """修改知识库显示名称。"""
        new_name = (name or "").strip()
        if not new_name:
            raise ValueError("name 不能为空")
        with self._lock:
            cfg = self._cache.get(kb_id)
            if not isinstance(cfg, dict):
                raise KeyError("kb_id 不存在")
            cfg["name"] = new_name
            cfg["updated_at"] = _now_iso()
            self._cache[kb_id] = cfg
            self._save()
            return dict(cfg)

    def set_match_prompt(self, *, kb_id: str, match_prompt: str) -> Dict[str, Any]:
        """保存该知识库专用的匹配模型 system 提示词；空字符串表示用默认提示词。"""
        with self._lock:
            cfg = self._cache.get(kb_id)
            if not isinstance(cfg, dict):
                raise KeyError("kb_id 不存在")
            cfg["match_prompt"] = match_prompt or ""
            cfg["updated_at"] = _now_iso()
            self._cache[kb_id] = cfg
            self._save()
            return dict(cfg)
