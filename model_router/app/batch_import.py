from __future__ import annotations

import json
import re
from typing import List, Literal


_QA_MD_RE = re.compile(
    r"^##\s*Q:\s*(?P<q>.+?)\s*\n+(?:A:\s*)?(?P<a>.+?)(?=^##\s*Q:|\Z)",
    re.MULTILINE | re.DOTALL,
)


def _normalize_entry(raw: dict) -> dict | None:
    if not isinstance(raw, dict):
        return None
    question = (
        raw.get("question")
        or raw.get("q")
        or raw.get("prompt")
        or ""
    )
    reference = (
        raw.get("reference_answer")
        or raw.get("reference")
        or raw.get("answer")
        or raw.get("a")
        or ""
    )
    q = str(question).strip()
    r = str(reference).strip()
    if not q or not r:
        return None
    out = {"question": q, "reference_answer": r}
    ks = str(raw.get("knowledge_source") or raw.get("source") or "").strip()
    agent_id = str(raw.get("agent_id") or raw.get("last_agent_id") or "").strip()
    if ks:
        out["knowledge_source"] = ks
    elif agent_id:
        out["knowledge_source"] = f"files/agent_{agent_id}/knowledge.md"
    return out


def parse_batch_import_json(text: str) -> List[dict]:
    payload = json.loads(text)
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict) and isinstance(payload.get("items"), list):
        rows = payload["items"]
    else:
        raise ValueError("JSON 须为数组或 {\"items\": [...]} 结构")
    out: List[dict] = []
    for row in rows:
        entry = _normalize_entry(row)
        if entry:
            out.append(entry)
    if not out:
        raise ValueError("JSON 中未解析到有效 question/reference_answer 条目")
    return out


def parse_batch_import_md(text: str) -> List[dict]:
    body = (text or "").strip()
    if not body:
        raise ValueError("MD 内容为空")
    out: List[dict] = []
    for m in _QA_MD_RE.finditer(body):
        q = m.group("q").strip()
        a = m.group("a").strip()
        if q and a:
            out.append({"question": q, "reference_answer": a})
    if not out:
        raise ValueError("MD 中未找到 ## Q: / A: 格式的条目")
    return out


def parse_batch_import_text(
    text: str,
    *,
    fmt: Literal["json", "md", "auto"] = "auto",
) -> List[dict]:
    raw = (text or "").strip()
    if not raw:
        raise ValueError("导入内容为空")

    if fmt == "json":
        return parse_batch_import_json(raw)
    if fmt == "md":
        return parse_batch_import_md(raw)

    # auto
    stripped = raw.lstrip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            return parse_batch_import_json(raw)
        except (json.JSONDecodeError, ValueError):
            pass
    if "## Q:" in raw or "## q:" in raw.lower():
        return parse_batch_import_md(raw)
    try:
        return parse_batch_import_json(raw)
    except json.JSONDecodeError:
        return parse_batch_import_md(raw)
