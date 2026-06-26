"""知识库元数据存储：读写 config/knowledge_bases.json。

管理知识库名称、match_prompt、创建时间等；不存储具体 FAQ 条目。
"""
from __future__ import annotations

import json
import shutil
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
    """线程安全的知识库配置 JSON 存储。"""

    path: Path  # knowledge_bases.json 路径
    _lock: threading.Lock
    _cache: Dict[str, Dict[str, Any]]  # kb_id -> 配置 dict

    @staticmethod
    def open(path: Path) -> "KbStore":
        """打开或初始化配置文件；结构必须为顶层 JSON object。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text("{}", encoding="utf-8")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeError("knowledge_bases.json 结构必须是 JSON object")
        return KbStore(path=path, _lock=threading.Lock(), _cache=data)

    def _save(self) -> None:
        """将内存缓存写回磁盘。"""
        self.path.write_text(json.dumps(self._cache, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_all(self) -> Dict[str, Dict[str, Any]]:
        """返回所有知识库配置的浅拷贝。"""
        with self._lock:
            return {kid: dict(v) for kid, v in self._cache.items() if isinstance(v, dict)}

    def get(self, kb_id: str) -> Optional[Dict[str, Any]]:
        """按 kb_id 取配置；不存在返回 None。"""
        with self._lock:
            cfg = self._cache.get(kb_id)
            return dict(cfg) if isinstance(cfg, dict) else None

    def next_available_kb_id(self) -> str:
        """分配最小未占用的数字 kb_id（"1", "2", ...）。"""
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
        """新建知识库元数据；kb_id 已存在则抛 ValueError。"""
        with self._lock:
            if kb_id in self._cache:
                raise ValueError("kb_id 已存在")
            now = _now_iso()
            cfg: Dict[str, Any] = {
                "name": name,
                "match_prompt": "",  # 空则运行时使用默认匹配规则
                "status": "ready",
                "created_at": now,
                "updated_at": now,
            }
            self._cache[kb_id] = cfg
            self._save()
            return dict(cfg)

    def delete_kb(self, *, kb_id: str) -> Dict[str, Any]:
        """从配置中删除知识库记录；磁盘文件需另调 delete_kb_files。"""
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

    def set_match_prompt(
        self,
        *,
        kb_id: str,
        match_prompt: str,
        confidence_match_prompt: str | None = None,
    ) -> Dict[str, Any]:
        """更新匹配规则文本；保存后需 QuestionsCache.reload_kb 重建 prompt。"""
        with self._lock:
            cfg = self._cache.get(kb_id)
            if not isinstance(cfg, dict):
                raise KeyError("kb_id 不存在")
            cfg["match_prompt"] = match_prompt or ""
            if confidence_match_prompt is not None:
                cfg["confidence_match_prompt"] = confidence_match_prompt or ""
            cfg["updated_at"] = _now_iso()
            self._cache[kb_id] = cfg
            self._save()
            return dict(cfg)

    def set_confidence_match_prompt(self, *, kb_id: str, confidence_match_prompt: str) -> Dict[str, Any]:
        """仅更新置信度匹配规则。"""
        return self.set_match_prompt(
            kb_id=kb_id,
            match_prompt=str(self._cache.get(kb_id, {}).get("match_prompt", "")),
            confidence_match_prompt=confidence_match_prompt,
        )

    def delete_kb_files(self, *, kb_id: str, files_root: Path) -> None:
        """递归删除 files/kb_{id} 整个目录（questions.json + assets）。"""
        from .paths import kb_dir_path

        target = kb_dir_path(files_root, kb_id)
        if target.exists():
            shutil.rmtree(target)
