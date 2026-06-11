from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple, Union

from .config import Settings
from .llm_client import ChatMessage, LLMClient, LLMError
from .knowledge_loader import (
    agent_files_dir,
    build_answer_system_content,
    build_answer_user_message,
    count_knowledge_lines,
    extract_image_citations_from_knowledge,
    count_system_images,
    format_system_content_for_log,
    format_cited_line_refs,
    is_not_found_answer,
    locate_answer_lines_in_knowledge,
    parse_line_citations_from_answer,
    finalize_model_answer_display,
    expand_citations_with_images_in_range,
    strip_citation_lines_from_answer,
    reconcile_answer_with_retrieval,
    resolve_agent_knowledge,
    strip_line_prefix,
)
from .schemas import AskTimings, Citation, MergedIllustration, PerAgentAnswer, PerAgentTimings, RouterResult, RouterTargetAgent


_SOURCE_RE = re.compile(r"\[\[SOURCE\s+file=(?P<file>[^\s\]]+)(?:\s+page=(?P<page>\d+))?\]\]")
_MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _extract_citations_from_context(*, question: str, context: str, max_items: int = 5) -> List[Citation]:
    """
    Heuristic evidence picker without vector DB:
    - Single-pass scan context, track current source (file/page)
    - Score lines by overlapping 2-char shingles with question
    """
    q = (question or "").strip()
    if not q or not context:
        return []

    stop = {"怎么", "如何", "为什么", "是否", "可以", "不能", "提示", "怎么办", "什么", "哪里", "有没有", "是否能", "怎么做"}
    shingles = set()
    for i in range(max(0, len(q) - 1)):
        s = q[i : i + 2]
        if not s.strip():
            continue
        if s in stop:
            continue
        if any(ch in "，。！？：；、()（）[]【】{}\"' \t\r\n" for ch in s):
            continue
        shingles.add(s)

    if not shingles:
        return []

    current_file: str | None = None
    current_page: int | None = None

    candidates: List[tuple[int, str, int | None, str, int | None]] = []
    for raw_line in context.splitlines():
        line_no, line = strip_line_prefix(raw_line.strip())
        if not line:
            continue

        m = _SOURCE_RE.search(line)
        if m:
            current_file = m.group("file")
            current_page = int(m.group("page")) if m.group("page") else None
            continue

        if line.startswith("=====") or line.startswith("[[SOURCE"):
            continue
        if _MD_IMG_RE.search(line):
            continue

        score = 0
        for sh in shingles:
            if sh in line:
                score += 1
        if score <= 0:
            continue

        f = current_file or ""
        candidates.append((score, f, current_page, line, line_no))

    # pick best unique
    candidates.sort(key=lambda x: x[0], reverse=True)
    out: List[Citation] = []
    seen = set()
    for score, f, p, line, line_no in candidates:
        key = (f, p, line)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            Citation(
                file=f or "",
                page=p,
                line_start=line_no,
                line_end=line_no,
                snippet=(line[:200] + "…") if len(line) > 200 else line,
            )
        )
        if len(out) >= max_items:
            break
    return out


def _is_image_file(path: str) -> bool:
    return Path(path).suffix.lower() in _IMAGE_EXTS


def _citations_to_illustrations(citations: List[Citation], *, max_items: int = 3) -> List[MergedIllustration]:
    out: List[MergedIllustration] = []
    seen: set[str] = set()
    for c in citations or []:
        asset = (c.asset_file or "").strip()
        f = asset or (c.file or "").strip()
        if not f or f in seen:
            continue
        is_img = _is_image_file(f)
        is_pdf = f.lower().endswith(".pdf") and c.page
        if not is_img and not is_pdf:
            continue
        seen.add(f)
        out.append(
            MergedIllustration(
                file=f,
                page=None if is_img else c.page,
                caption=(c.snippet or "")[:200],
            )
        )
        if len(out) >= max_items:
            break
    return out


def _build_illustration_pool(answers: List[PerAgentAnswer]) -> List[dict]:
    pool: List[dict] = []
    seen: set[tuple[str, int | None, str]] = set()
    for a in answers:
        for c in (a.citations or [])[:8]:
            key = (c.file, c.page, c.snippet)
            if key in seen:
                continue
            seen.add(key)
            pool.append({"file": c.file, "page": c.page, "snippet": c.snippet})
    return pool


def _parse_merge_illustrations(ill: object, pool: List[dict]) -> List[MergedIllustration]:
    if not isinstance(ill, list):
        return []

    allowed_pairs = {(c["file"], c.get("page")) for c in pool}
    allowed_files = {c["file"] for c in pool}
    out: List[MergedIllustration] = []
    seen_files: set[str] = set()

    for it in ill[:3]:
        if not isinstance(it, dict):
            continue
        f = str(it.get("file", "")).strip()
        if not f or f in seen_files:
            continue

        p = it.get("page")
        p_int = int(p) if isinstance(p, (int, float, str)) and str(p).isdigit() and int(p) > 0 else None
        if _is_image_file(f):
            if f not in allowed_files:
                continue
            p_int = None
        elif (f, p_int) not in allowed_pairs:
            continue

        seen_files.add(f)
        caption = str(it.get("caption", "") or "").strip()
        if not caption:
            match = next((c for c in pool if c["file"] == f and c.get("page") == p_int), None)
            caption = str((match or {}).get("snippet") or "")[:200]
        out.append(MergedIllustration(file=f, page=p_int, caption=caption))

    return out


def _fill_illustrations_from_pool(
    illustrations: List[MergedIllustration],
    pool: List[dict],
    *,
    max_items: int = 3,
) -> List[MergedIllustration]:
    out = list(illustrations)
    seen = {x.file for x in out}
    for c in pool:
        if len(out) >= max_items:
            break
        f = str(c.get("file", "")).strip()
        if not f or f in seen:
            continue
        is_img = _is_image_file(f)
        is_pdf = f.lower().endswith(".pdf") and c.get("page")
        if not is_img and not is_pdf:
            continue
        seen.add(f)
        out.append(
            MergedIllustration(
                file=f,
                page=None if is_img else c.get("page"),
                caption=str(c.get("snippet") or "")[:200],
            )
        )
    return out[:max_items]


MERGE_SYSTEM_PROMPT_ZH = """你是“多 agent 回答合并器（图文版）”。
你不会读取任何原始文件；你只能基于输入中提供的各 agent 的回答与引用证据（citations）进行合并总结与挑选插图。

你的输出面向最终用户，必须像正常客服/助手一样回答，**不要在合并回答文本里暴露任何内部证据定位信息**。

任务：
1) 生成对用户的最终回答 merged_answer（中文、直接可执行、自然流畅）
2) 从候选 citations 中选择 1~3 个最能支撑结论的证据页作为 illustrations（用于前端展示“图文并茂”）

规则：
- 禁止引入外部知识，禁止编造。
- 如果某些 agent 明确表示“当前知识库中未找到相关信息”，在合并结果里如实说明缺失项。
- merged_answer 用自然中文直接回答，不要使用「一、结论 / 二、依据 / 三、补充说明」等固定分段标题。
- merged_answer 中禁止出现：文件路径、文件名、页码、行号、page/p./L123、SOURCE 标记、agent_id 等内部标识。
- merged_answer 中禁止出现任何“多答案/多来源”的元叙事措辞，例如：\n  “有一份回答…/另一份回答…/根据多个回答…/某个 agent…/综合以上/从目录判断…”。\n  你必须把输入内容融合成**一份统一口吻**的最终答复，像你自己在直接回答用户问题。
- 尽量给出**清单化步骤**与用户可执行的操作（如果输入里包含步骤信息）。
- illustrations 只能从你收到的 candidates 里挑选（不要编造 file/page）；图片 citation 的 page 可为 null。
__LENGTH_RULE__

严格输出 JSON（只输出 JSON 本体，不要 Markdown 代码块）：
{
  "merged_answer": "…",
  "illustrations": [
    { "file": "files/assets/p016_figure_clip_001.png", "page": null, "caption": "这图展示了…（不需要写路径）" },
    { "file": "files/agent_13/xxx.pdf", "page": 12, "caption": "这页展示了…（不需要写页码/路径）" }
  ]
}"""


def _extract_first_json_object(text: str) -> str:
    s = (text or "").strip()
    if not s:
        raise ValueError("合并模型输出为空")
    if s.startswith("{") and s.endswith("}"):
        return s
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("合并模型输出不包含可解析的 JSON 对象")
    return s[start : end + 1]


def _merge_system_prompt(*, max_answer_chars: int) -> str:
    length_rule = ""
    if max_answer_chars > 0:
        length_rule = (
            f"- merged_answer 正文总计不超过 {max_answer_chars} 个汉字，务必精炼。\n"
        )
    return MERGE_SYSTEM_PROMPT_ZH.replace("__LENGTH_RULE__", length_rule)


def _merge_answers(
    answers: List[PerAgentAnswer],
    *,
    llm: LLMClient,
    settings: Settings,
) -> tuple[str, List[MergedIllustration], float]:
    if not answers:
        return "", [], 0.0
    if len(answers) == 1:
        a = answers[0]
        return a.answer, _citations_to_illustrations(a.citations), 0.0

    pool = _build_illustration_pool(answers)

    payload = {
        # Provide anonymous answers to reduce the chance of meta narration like "某份回答".
        "answers": [{"answer": a.answer} for a in answers],
        "candidates": pool,
    }

    t0 = time.perf_counter()
    raw = llm.chat(
        model=settings.answer_model,
        messages=[
            ChatMessage(role="system", content=_merge_system_prompt(max_answer_chars=settings.max_answer_chars)),
            ChatMessage(role="user", content=json.dumps(payload, ensure_ascii=False)),
        ],
        max_tokens=settings.answer_max_tokens,
    )
    merge_ms = (time.perf_counter() - t0) * 1000.0

    try:
        obj = json.loads(_extract_first_json_object(raw))
    except Exception as e:  # noqa: BLE001
        raise LLMError(f"合并模型输出解析失败：{type(e).__name__}: {e}. 原始输出：{raw[:800]}") from e

    merged_answer = str(obj.get("merged_answer", "") or "").strip()
    illustrations = _parse_merge_illustrations(obj.get("illustrations", []), pool)
    illustrations = _fill_illustrations_from_pool(illustrations, pool, max_items=3)

    return merged_answer, illustrations, merge_ms


def _prepare_agent_run(
    *,
    target: RouterTargetAgent,
    question: str,
    cfg: Dict,
    settings: Settings,
) -> Tuple[str, str, str, Union[str, List[Dict[str, Any]]], Optional[str], str, float, str, List[Citation]]:
    agent_name = cfg.get("name", target.agent_id)
    files_dir = agent_files_dir(target.agent_id)
    configured_knowledge = str(cfg.get("knowledge", "") or cfg.get("answer_prompt", "") or "")
    answer_instructions = str(cfg.get("answer_instructions", "") or "")

    t1 = time.perf_counter()
    knowledge_text, knowledge_source, context_note = resolve_agent_knowledge(
        project_root=settings.data_root,
        agent_id=target.agent_id,
        configured_knowledge=configured_knowledge,
        max_chars=settings.max_file_chars,
    )
    load_files_ms = (time.perf_counter() - t1) * 1000.0

    user_message = ""
    retrieval_citations: List[Citation] = []
    system_message: Union[str, List[Dict[str, Any]]] = ""
    if knowledge_text:
        system_message = build_answer_system_content(
            agent_name=agent_name,
            knowledge=knowledge_text,
            knowledge_source=knowledge_source,
            answer_instructions=answer_instructions,
            project_root=settings.data_root,
            files_dir=files_dir,
            max_answer_chars=settings.max_answer_chars,
            include_images=settings.answer_with_images,
            max_images=settings.max_answer_images,
        )
        user_message, retrieval_citations = build_answer_user_message(
            question=question,
            rewritten_query=target.rewritten_query or "",
        )
    return (
        agent_name,
        knowledge_text,
        knowledge_source,
        system_message,
        context_note,
        files_dir,
        load_files_ms,
        user_message,
        retrieval_citations,
    )


def summarize_agent_prepare(
    *,
    target: RouterTargetAgent,
    question: str,
    cfg: Dict,
    settings: Settings,
) -> Dict[str, Any]:
    """Return diagnostics for logging (loads knowledge + retrieval once)."""
    (
        agent_name,
        knowledge_text,
        knowledge_source,
        _system_message,
        context_note,
        _files_dir,
        load_files_ms,
        user_message,
        retrieval_citations,
    ) = _prepare_agent_run(
        target=target,
        question=question,
        cfg=cfg,
        settings=settings,
    )
    system_log = format_system_content_for_log(_system_message) if _system_message else ""
    return {
        "agent_id": target.agent_id,
        "agent_name": agent_name,
        "knowledge_source": knowledge_source or "",
        "knowledge_chars": len(knowledge_text),
        "knowledge_lines": count_knowledge_lines(knowledge_text) if knowledge_text else 0,
        "system_chars": len(system_log),
        "system_images": count_system_images(_system_message) if _system_message else 0,
        "load_files_ms": round(load_files_ms, 1),
        "retrieval_hits": len(retrieval_citations),
        "retrieval": [],
        "rewritten_query": (target.rewritten_query or "").strip(),
        "user_message_chars": len(user_message),
        "context_note": context_note or "",
        "answer_model": settings.answer_model,
        "answer_with_images": settings.answer_with_images,
    }


def _empty_knowledge_answer(agent_id: str) -> str:
    return (
        "当前 agent 未配置知识内容。\n\n"
        f"请在 files/agent_{agent_id}/ 下放置 knowledge.md（或任意 .md），"
        "或在 agents.json 配置 knowledge 字段后重新初始化。"
    )


def _used_files_from_citations(citations: List[Citation], knowledge_source: str = "") -> List[str]:
    refs = format_cited_line_refs(citations, knowledge_source)
    if refs:
        return refs
    src = (knowledge_source or "").strip()
    return [src] if src else []


def _build_agent_citations(
    *,
    question: str,
    answer: str,
    knowledge_text: str,
    knowledge_source: str,
    project_root: Path,
    files_dir: str,
) -> List[Citation]:
    parsed = parse_line_citations_from_answer(
        answer=answer,
        knowledge_source=knowledge_source,
        knowledge=knowledge_text,
    )
    if parsed:
        return parsed[:5]

    image_citations = extract_image_citations_from_knowledge(
        question=question,
        knowledge=knowledge_text,
        knowledge_source=knowledge_source,
        project_root=project_root,
        files_dir=files_dir,
        max_items=5,
    )
    citations = list(image_citations)
    if len(citations) < 5:
        text_citations = _extract_citations_from_context(question=question, context=knowledge_text, max_items=5)
        seen = {(c.file, c.page, c.line_start, c.line_end, c.snippet) for c in citations}
        for c in text_citations:
            if not c.file and knowledge_source:
                c = c.model_copy(update={"file": knowledge_source})
            key = (c.file, c.page, c.line_start, c.line_end, c.snippet)
            if key in seen:
                continue
            seen.add(key)
            citations.append(c)
            if len(citations) >= 5:
                break
    return citations


def _merge_citations(*groups: List[Citation], max_items: int = 5) -> List[Citation]:
    out: List[Citation] = []
    seen: set[tuple] = set()
    for group in groups:
        for c in group:
            key = (c.file, c.asset_file, c.page, c.line_start, c.line_end, c.snippet)
            if key in seen:
                continue
            seen.add(key)
            out.append(c)
            if len(out) >= max_items:
                return out
    return out


def _collect_citations(
    *,
    question: str,
    answer: str,
    knowledge_text: str,
    knowledge_source: str,
    project_root: Path,
    files_dir: str,
    retrieval_citations: List[Citation],
) -> List[Citation]:
    parsed = parse_line_citations_from_answer(
        answer=answer,
        knowledge_source=knowledge_source,
        knowledge=knowledge_text,
    )
    if parsed:
        return expand_citations_with_images_in_range(
            parsed,
            knowledge=knowledge_text,
            project_root=project_root,
            files_dir=files_dir,
        )[:8]

    answer_lines = locate_answer_lines_in_knowledge(
        answer=answer,
        knowledge=knowledge_text,
        knowledge_source=knowledge_source,
    )
    built = _build_agent_citations(
        question=question,
        answer=answer,
        knowledge_text=knowledge_text,
        knowledge_source=knowledge_source,
        project_root=project_root,
        files_dir=files_dir,
    )
    return _merge_citations(answer_lines, retrieval_citations, built)


def _resolve_display_answer_and_citations(
    *,
    raw_answer: str,
    question: str,
    knowledge_text: str,
    knowledge_source: str,
    project_root: Path,
    files_dir: str,
    retrieval_citations: List[Citation],
) -> Tuple[str, List[Citation]]:
    """Prefer model 【引用】/inline images; fallback to heuristic citations."""
    raw = (raw_answer or "").strip()
    display, model_cites = finalize_model_answer_display(
        raw_answer=raw,
        knowledge=knowledge_text,
        knowledge_source=knowledge_source,
        project_root=project_root,
        files_dir=files_dir,
    )
    if model_cites:
        return display, model_cites
    return raw, _collect_citations(
        question=question,
        answer=raw,
        knowledge_text=knowledge_text,
        knowledge_source=knowledge_source,
        project_root=project_root,
        files_dir=files_dir,
        retrieval_citations=retrieval_citations,
    )


def _run_single_agent(
    *,
    target: RouterTargetAgent,
    question: str,
    cfg: Dict,
    llm: LLMClient,
    settings: Settings,
) -> PerAgentAnswer:
    t_agent0 = time.perf_counter()
    (
        agent_name,
        knowledge_text,
        knowledge_source,
        system_message,
        context_note,
        files_dir,
        load_files_ms,
        user_message,
        retrieval_citations,
    ) = _prepare_agent_run(
        target=target,
        question=question,
        cfg=cfg,
        settings=settings,
    )

    if not knowledge_text:
        answer_text = _empty_knowledge_answer(target.agent_id)
        t_agent_ms = (time.perf_counter() - t_agent0) * 1000.0
        return PerAgentAnswer(
            agent_id=target.agent_id,
            agent_name=agent_name,
            knowledge_source=knowledge_source or "",
            used_files=_used_files_from_citations([], knowledge_source),
            context_note=None,
            route=target,
            answer=answer_text,
            citations=[],
            timings=PerAgentTimings(
                total_ms=t_agent_ms,
                expand_files_ms=0.0,
                load_files_ms=load_files_ms,
                llm_answer_ms=0.0,
                citations_ms=0.0,
            ),
        )

    user_parts: List[str] = []
    if context_note:
        user_parts.append(context_note)
    user_parts.append(user_message)

    t2 = time.perf_counter()
    answer = llm.chat(
        model=settings.answer_model,
        messages=[
            ChatMessage(role="system", content=system_message),
            ChatMessage(role="user", content="\n\n".join(user_parts).strip()),
        ],
        max_tokens=settings.answer_max_tokens,
    )
    llm_answer_ms = (time.perf_counter() - t2) * 1000.0

    t3 = time.perf_counter()
    final_answer = reconcile_answer_with_retrieval(
        answer.strip(),
        knowledge=knowledge_text,
        retrieval_citations=retrieval_citations,
        fallback_citations=[],
        max_chars=settings.max_answer_chars,
    )
    final_answer, citations = _resolve_display_answer_and_citations(
        raw_answer=final_answer,
        question=question,
        knowledge_text=knowledge_text,
        knowledge_source=knowledge_source,
        project_root=settings.data_root,
        files_dir=files_dir,
        retrieval_citations=retrieval_citations,
    )
    if is_not_found_answer(final_answer):
        final_answer = reconcile_answer_with_retrieval(
            final_answer,
            knowledge=knowledge_text,
            retrieval_citations=retrieval_citations,
            fallback_citations=citations,
            max_chars=settings.max_answer_chars,
        )
        final_answer, citations = _resolve_display_answer_and_citations(
            raw_answer=final_answer,
            question=question,
            knowledge_text=knowledge_text,
            knowledge_source=knowledge_source,
            project_root=settings.data_root,
            files_dir=files_dir,
            retrieval_citations=retrieval_citations,
        )
    citations_ms = (time.perf_counter() - t3) * 1000.0

    t_agent_ms = (time.perf_counter() - t_agent0) * 1000.0
    return PerAgentAnswer(
        agent_id=target.agent_id,
        agent_name=agent_name,
        knowledge_source=knowledge_source or "",
        used_files=_used_files_from_citations(citations, knowledge_source),
        context_note=context_note,
        route=target,
        answer=final_answer,
        citations=citations,
        timings=PerAgentTimings(
            total_ms=t_agent_ms,
            expand_files_ms=0.0,
            load_files_ms=load_files_ms,
            llm_answer_ms=llm_answer_ms,
            citations_ms=citations_ms,
        ),
    )


def stream_single_agent_answer(
    *,
    target: RouterTargetAgent,
    question: str,
    cfg: Dict,
    llm: LLMClient,
    settings: Settings,
) -> Iterator[str]:
    (
        _agent_name,
        knowledge_text,
        _knowledge_source,
        system_message,
        context_note,
        _files_dir,
        _load_files_ms,
        user_message,
        _retrieval_citations,
    ) = _prepare_agent_run(
        target=target,
        question=question,
        cfg=cfg,
        settings=settings,
    )

    if not knowledge_text:
        yield _empty_knowledge_answer(target.agent_id)
        return

    user_parts: List[str] = []
    if context_note:
        user_parts.append(context_note)
    user_parts.append(user_message)

    yield from llm.chat_stream(
        model=settings.answer_model,
        messages=[
            ChatMessage(role="system", content=system_message),
            ChatMessage(role="user", content="\n\n".join(user_parts).strip()),
        ],
        max_tokens=settings.answer_max_tokens,
    )


def finalize_streamed_agent_answer(
    *,
    target: RouterTargetAgent,
    question: str,
    cfg: Dict,
    settings: Settings,
    answer_text: str,
    agents_ms: float,
    llm_answer_ms: float,
) -> PerAgentAnswer:
    (
        agent_name,
        knowledge_text,
        knowledge_source,
        _system_message,
        context_note,
        files_dir,
        load_files_ms,
        _user_message,
        retrieval_citations,
    ) = _prepare_agent_run(
        target=target,
        question=question,
        cfg=cfg,
        settings=settings,
    )

    t3 = time.perf_counter()
    final_answer = reconcile_answer_with_retrieval(
        answer_text.strip(),
        knowledge=knowledge_text,
        retrieval_citations=retrieval_citations,
        fallback_citations=[],
        max_chars=settings.max_answer_chars,
    )
    if knowledge_text:
        final_answer, citations = _resolve_display_answer_and_citations(
            raw_answer=final_answer,
            question=question,
            knowledge_text=knowledge_text,
            knowledge_source=knowledge_source,
            project_root=settings.data_root,
            files_dir=files_dir,
            retrieval_citations=retrieval_citations,
        )
    else:
        citations = list(retrieval_citations)
    if is_not_found_answer(final_answer) and citations:
        final_answer = reconcile_answer_with_retrieval(
            final_answer,
            knowledge=knowledge_text,
            retrieval_citations=retrieval_citations,
            fallback_citations=citations,
            max_chars=settings.max_answer_chars,
        )
        if knowledge_text:
            final_answer, citations = _resolve_display_answer_and_citations(
                raw_answer=final_answer,
                question=question,
                knowledge_text=knowledge_text,
                knowledge_source=knowledge_source,
                project_root=settings.data_root,
                files_dir=files_dir,
                retrieval_citations=retrieval_citations,
            )
    citations_ms = (time.perf_counter() - t3) * 1000.0

    return PerAgentAnswer(
        agent_id=target.agent_id,
        agent_name=agent_name,
        knowledge_source=knowledge_source or "",
        used_files=_used_files_from_citations(citations, knowledge_source),
        context_note=context_note,
        route=target,
        answer=final_answer,
        citations=citations,
        timings=PerAgentTimings(
            total_ms=agents_ms,
            expand_files_ms=0.0,
            load_files_ms=load_files_ms,
            llm_answer_ms=llm_answer_ms,
            citations_ms=citations_ms,
        ),
    )


def run_agents(
    *,
    question: str,
    route_result: RouterResult,
    agents: Dict[str, Dict],
    llm: LLMClient,
    settings: Settings,
) -> Tuple[List[PerAgentAnswer], str, List[MergedIllustration], AskTimings]:
    if route_result.need_clarification:
        return [], "", [], AskTimings()

    targets = [t for t in route_result.target_agents if t.agent_id in agents][:1]
    if not targets:
        return [], "", [], AskTimings()

    t_agents0 = time.perf_counter()
    target = targets[0]
    answer = _run_single_agent(
        target=target,
        question=question,
        cfg=agents[target.agent_id],
        llm=llm,
        settings=settings,
    )
    agents_ms = (time.perf_counter() - t_agents0) * 1000.0
    illustrations = _citations_to_illustrations(answer.citations)
    timings = AskTimings(agents_ms=agents_ms, merge_ms=0.0)
    return [answer], answer.answer, illustrations, timings

