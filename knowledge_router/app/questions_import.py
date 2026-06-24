from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Tuple

from .llm_client import ChatMessage, LLMClient, LLMError

IMPORT_SYSTEM_PROMPT_ZH = """你是 FAQ 知识库生成器。根据 Markdown 知识文档拆分为多条问答条目，供后续语义匹配使用。

拆分规则：
1. 优先按 `#` 一级标题拆分；若同一 `#` 下多个 `##` 二级标题各自内容充实且主题独立，则按 `##` 各拆一条。
2. 若多个 `##` 主题相关、内容简短（如显示屏不同角度），或属于同一操作流程，合并为一条。
3. 跳过「本页插图」等无实质内容的占位标题。
4. answer 必须保留原文 Markdown：表格、列表、加粗、图片 `![...](assets/xxx.png)` 路径原样保留，不要删图。
5. answer 开头必须保留该条对应的章节标题行（拆分用的 `#` 或 `##` 标题，如 `## M（手动）`），作为 answer 第一行，不要省略标题只写正文。
6. 每条输出：question（一句标准问法）、variants（恰好 3 条用户口语/模糊问法，互不重复）。
7. question 应像真实用户会问的话，不要只抄标题。

输出严格 JSON，不要 Markdown 代码块，不要额外说明：

{{
  "items": [
    {{
      "question": "标准问题？",
      "variants": ["变体1", "变体2", "变体3"],
      "answer": "Markdown 回答正文"
    }}
  ]
}}"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _extract_first_json_object(text: str) -> str:
    s = (text or "").strip()
    if not s:
        raise ValueError("模型输出为空")
    if s.startswith("{") and s.endswith("}"):
        return s
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("模型输出不包含 JSON 对象")
    return s[start : end + 1]


def strip_md_frontmatter(text: str) -> str:
    body = text or ""
    if body.startswith("---"):
        end = body.find("\n---", 3)
        if end != -1:
            body = body[end + 4 :]
    return body.strip()


def normalize_import_items(raw_items: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_items, list):
        raise LLMError("模型输出 items 必须是数组")
    out: List[Dict[str, str]] = []
    for row in raw_items:
        if not isinstance(row, dict):
            continue
        question = str(row.get("question", "")).strip()
        answer = str(row.get("answer", "")).strip()
        variants_raw = row.get("variants", [])
        if not question or not answer:
            continue
        variants: List[str] = []
        if isinstance(variants_raw, list):
            for v in variants_raw:
                s = str(v).strip()
                if s and s not in variants:
                    variants.append(s)
        while len(variants) < 3:
            variants.append(question)
        variants = variants[:3]
        out.append({"question": question, "variants": variants, "answer": answer})
    if not out:
        raise LLMError("模型未生成有效 FAQ 条目")
    return out


def generate_faq_items_from_markdown(
    *,
    md_text: str,
    source_label: str,
    llm: LLMClient,
    import_model: str,
) -> List[Dict[str, str]]:
    body = strip_md_frontmatter(md_text)
    if not body:
        raise LLMError(f"{source_label} 内容为空")
    payload = {"source": source_label, "markdown": body}
    raw = llm.chat(
        model=import_model,
        messages=[
            ChatMessage(role="system", content=IMPORT_SYSTEM_PROMPT_ZH),
            ChatMessage(role="user", content=json.dumps(payload, ensure_ascii=False)),
        ],
        max_tokens=8192,
        temperature=0.2,
    )
    try:
        obj = json.loads(_extract_first_json_object(raw))
    except Exception as e:  # noqa: BLE001
        raise LLMError(f"{source_label} 解析失败：{e}. 原始输出：{raw[:600]}") from e
    return normalize_import_items(obj.get("items", []))


def copy_agent_assets(*, agent_assets_dir: Path, kb_assets_dir: Path) -> int:
    kb_assets_dir.mkdir(parents=True, exist_ok=True)
    if not agent_assets_dir.is_dir():
        return 0
    count = 0
    for src in agent_assets_dir.glob("*"):
        if src.is_file():
            shutil.copy2(src, kb_assets_dir / src.name)
            count += 1
    return count


def assign_question_ids(items: Iterable[Dict[str, Any]], *, start: int = 1) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    n = start
    for item in items:
        out.append(
            {
                "id": f"q{n:03d}",
                "question": item["question"],
                "variants": item.get("variants", [])[:3],
                "answer": item["answer"],
                "enabled": True,
                "updated_at": _now_iso(),
            }
        )
        n += 1
    return out


def list_agent_md_files(router_dir: Path, agent_nums: List[int]) -> List[Tuple[int, Path]]:
    found: List[Tuple[int, Path]] = []
    for num in agent_nums:
        md_dir = router_dir / f"agent_{num}" / "md"
        if not md_dir.is_dir():
            continue
        for md in sorted(md_dir.glob("*.md")):
            found.append((num, md))
    return found


def import_router_agents(
    *,
    router_dir: Path,
    kb_assets_dir: Path,
    agent_nums: List[int],
    llm: LLMClient,
    import_model: str,
    on_progress: Callable[[str], None] | None = None,
) -> List[Dict[str, Any]]:
    all_items: List[Dict[str, Any]] = []
    md_files = list_agent_md_files(router_dir, agent_nums)
    if not md_files:
        raise LLMError(f"未在 {router_dir} 找到 agent md 文件")
    for agent_num, md_path in md_files:
        label = f"agent_{agent_num}/{md_path.name}"
        if on_progress:
            on_progress(f"LLM 拆分 {label} …")
        items = generate_faq_items_from_markdown(
            md_text=md_path.read_text(encoding="utf-8"),
            source_label=label,
            llm=llm,
            import_model=import_model,
        )
        assets_dir = router_dir / f"agent_{agent_num}" / "assets"
        copied = copy_agent_assets(agent_assets_dir=assets_dir, kb_assets_dir=kb_assets_dir)
        if on_progress:
            on_progress(f"  -> {len(items)} 条 FAQ，复制 {copied} 个资源")
        all_items.extend(items)
    return all_items
