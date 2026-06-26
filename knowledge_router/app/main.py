"""FastAPI 应用入口：问答 API、知识库 CRUD、静态 Web 控制台。

核心流程：置信度匹配 _run_confidence_match -> parse_confidence_raw -> Top1 answer
"""
from __future__ import annotations

import json
import queue
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import APP_ROOT, Settings
from .file_processor import (
    extract_markdown_range,
    extract_pdf_to_markdown,
)
from .kb_store import KbStore
from .llm_client import ChatMessage, LLMClient, LLMError
from .match_profiles_store import MatchProfile, MatchProfilesStore
from .markdown_files import (
    build_markdown_files_tree,
    create_module_markdown,
    delete_document_file,
    documents_source_path,
    read_markdown_content,
    rename_document_file,
    save_markdown_content,
)
from .matcher import (
    build_match_messages,
    build_question_list_section,
    count_question_prompt_lines,
    default_confidence_match_prompt,
    parse_confidence_raw,
)
from .models_store import ModelsStore
from .operation_log import OperationLog
from .prompt_defaults import all_default_prompts
from .prompts_store import PromptsStore
from .paths import (
    documents_assets_dir_path,
    documents_sources_dir_path,
    kb_assets_dir_path,
    kb_dir_path,
    questions_json_path,
    recall_tests_json_path,
)
from .questions_cache import QuestionsCache
from .questions_import import assign_question_ids, generate_faq_questions_only
from .schemas import (
    AskTimings,
    CandidateAnswer,
    ConfidenceAskRequest,
    ConfidenceAskResponse,
    ConfidenceCandidate,
    ConfidenceMatchResult,
    ConfidencePromptPreviewResponse,
    HealthResponse,
    KnowledgeBaseCreateRequest,
    KnowledgeBaseRenameRequest,
    PhaseTokens,
    QAItemUpsertRequest,
    QuestionsDocument,
    QuestionsReplaceRequest,
    RecallTestDocument,
    TokenUsage,
)


def _sse(event: str, data: Dict[str, Any]) -> str:
    """格式化为 SSE 单条事件（event + data JSON）。"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def _format_timings_log(timings: AskTimings) -> str:
    """将 AskTimings 格式化为单行日志，供前端日志面板展示。"""
    tok = timings.tokens
    return (
        f"[timing] 准备(索引+prompt)={timings.prepare_ms:.1f}ms "
        f"匹配(LLM)={timings.match_ms:.1f}ms "
        f"首token={timings.match_first_token_ms:.1f}ms "
        f"查表(取answer)={timings.lookup_ms:.2f}ms "
        f"总计={timings.total_ms:.1f}ms "
        f"tokens={tok.total_tokens or timings.match_output_tokens}"
    )


def _apply_usage_to_timings(timings: AskTimings, usage_dict: Dict[str, int], *, phase: str = "match") -> None:
    pt = int(usage_dict.get("prompt_tokens", 0) or 0)
    ct = int(usage_dict.get("completion_tokens", 0) or 0)
    tt = int(usage_dict.get("total_tokens", 0) or 0) or (pt + ct)
    timings.tokens = TokenUsage(prompt_tokens=pt, completion_tokens=ct, total_tokens=tt)
    timings.match_output_tokens = ct or timings.match_output_tokens
    timings.token_breakdown = [PhaseTokens(phase=phase, usage=timings.tokens)]


class AskLogSink:
    """问答流水线日志收集器；可同步写入内存或实时 emit 到 SSE 队列。"""

    def __init__(
        self,
        *,
        emit: Callable[[str, str], None] | None = None,
        op_log: OperationLog | None = None,
        module: str = "debug",
        kb_id: str = "",
    ) -> None:
        self._entries: List[tuple[str, str]] = []
        self._emit = emit
        self._op_log = op_log
        self._module = module
        self._kb_id = kb_id

    def log(self, line: str, kind: str = "log") -> None:
        """记录一行日志；kind 用于前端着色（step/match/prompt 等）。"""
        self._entries.append((line, kind))
        if self._emit is not None:
            self._emit(line, kind)
        if self._op_log is not None:
            self._op_log.append(
                module=self._module,
                action=kind,
                kb_id=self._kb_id,
                detail=line,
                kind=kind,
            )

    def drain(self) -> List[tuple[str, str]]:
        """取出并清空缓冲（非流式场景备用）。"""
        out = list(self._entries)
        self._entries.clear()
        return out


def _validate_kb_id(kb_store: KbStore, kb_id: str) -> str:
    """校验 kb_id 非空且存在于配置；失败抛 HTTPException。"""
    kid = (kb_id or "").strip()
    if not kid:
        raise HTTPException(status_code=400, detail="kb_id 不能为空")
    if not kb_store.get(kid):
        raise HTTPException(status_code=404, detail="kb_id 不存在")
    return kid


def _normalize_import_ranges(ranges: Any) -> List[tuple[int, int]]:
    out: List[tuple[int, int]] = []
    for r in ranges or []:
        if not isinstance(r, (list, tuple)) or len(r) < 2:
            continue
        try:
            s, e = int(r[0]), int(r[1])
        except (TypeError, ValueError):
            continue
        if s >= 1 and e >= s:
            out.append((s, e))
    return out


def _merge_extract_stats(acc: Dict[str, Any], stats: Dict[str, Any]) -> Dict[str, Any]:
    if not acc:
        merged = dict(stats)
        mp = stats.get("module_path") or ""
        merged["module_paths"] = [mp] if mp else []
        return merged
    acc_timings = dict(acc.get("timings") or {})
    st_timings = stats.get("timings") or {}
    for k in set(acc_timings) | set(st_timings):
        acc_timings[k] = (acc_timings.get(k) or 0) + (st_timings.get(k) or 0)
    acc_tokens = dict(acc.get("tokens") or {})
    st_tokens = stats.get("tokens") or {}
    for k in ("total_tokens", "prompt_tokens", "completion_tokens"):
        acc_tokens[k] = (acc_tokens.get(k) or 0) + (st_tokens.get(k) or 0)
    module_paths = list(acc.get("module_paths") or [])
    mp = stats.get("module_path") or ""
    if mp:
        module_paths.append(mp)
    return {
        **acc,
        "timings": acc_timings,
        "tokens": acc_tokens,
        "token_breakdown": (acc.get("token_breakdown") or []) + (stats.get("token_breakdown") or []),
        "pages": (acc.get("pages") or 0) + (stats.get("pages") or 0),
        "line_count": (acc.get("line_count") or 0) + (stats.get("line_count") or 0),
        "module_paths": module_paths,
        "module_path": mp or acc.get("module_path", ""),
    }


def _run_confidence_match(
    *,
    question: str,
    kb_id: str,
    top_k: int,
    cache: QuestionsCache,
    llm: LLMClient,
    settings: Settings,
    log_sink: AskLogSink | None = None,
    match_model: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> tuple[ConfidenceMatchResult, AskTimings, str, list[dict[str, str]], ConfidenceAskResponse]:
    """执行置信度匹配：流式 LLM 输出 JSON 数组 -> 解析多候选 -> Top1 answer。"""
    def _log(line: str, kind: str = "log") -> None:
        if log_sink is not None:
            log_sink.log(line, kind)

    timings = AskTimings()
    t0 = time.perf_counter()
    _log(f"[step] _run_confidence_match 开始 kb_id={kb_id} top_k={top_k}", "step")

    idx = cache.get_index(kb_id)
    if idx is None:
        _log("[cache] 内存索引未命中，执行 load_kb()", "cache")
        idx = cache.load_kb(kb_id)
    else:
        _log(f"[cache] 命中内存索引 loaded_at={idx.loaded_at}", "cache")

    prompt_lines = count_question_prompt_lines(idx.enabled_items)
    _log(f"[cache] enabled_items={len(idx.enabled_items)} prompt_lines={prompt_lines}", "cache")

    system_prompt = cache.get_confidence_system_prompt(kb_id, top_k=top_k)
    messages_dict = build_match_messages(system_prompt=system_prompt, user_question=question)
    messages = [ChatMessage(role=m["role"], content=m["content"]) for m in messages_dict]

    _log(f"[prompt] confidence system 长度={len(system_prompt)} 字符", "prompt")
    _log(f"[prompt] confidence system 内容:\n{system_prompt}", "prompt")
    _log(f"[prompt] user 消息:\n{question}", "prompt")
    model_name = match_model or settings.match_model
    tok = max_tokens if max_tokens is not None else settings.confidence_max_tokens
    temp = temperature if temperature is not None else settings.match_temperature
    _log(
        f"[match] 调用 LLM model={model_name} max_tokens={tok} temperature={temp}",
        "match",
    )

    t_match0 = time.perf_counter()
    timings.prepare_ms = (t_match0 - t0) * 1000.0
    first_token_ms = 0.0
    buffer = ""
    got_first = False
    delta_count = 0

    usage_holder: List[Any] = []
    for delta in llm.chat_stream(
        model=model_name,
        messages=messages,
        max_tokens=tok,
        temperature=temp,
        mock_mode="confidence",
        usage_out=usage_holder,
    ):
        delta_count += 1
        if not got_first:
            first_token_ms = (time.perf_counter() - t_match0) * 1000.0
            got_first = True
            _log(f"[match] 首 token 到达 +{first_token_ms:.1f}ms", "match")
        buffer += delta

    raw = buffer.strip()
    timings.match_ms = (time.perf_counter() - t_match0) * 1000.0
    timings.match_first_token_ms = first_token_ms
    if usage_holder:
        _apply_usage_to_timings(timings, usage_holder[0].to_dict(), phase="置信度匹配")
    else:
        timings.match_output_tokens = max(1, len(raw.split())) if raw else 0
    _log(f"[match] stream 结束 deltas={delta_count} raw_output={raw!r}", "match")

    parsed, raw_output = parse_confidence_raw(raw=raw, valid_ids=idx.valid_ids, top_k=top_k)
    candidates: List[ConfidenceCandidate] = []
    answers: List[CandidateAnswer] = []
    for row in parsed:
        item = cache.resolve_item(kb_id, row["id"])
        q_text = item.question if item else ""
        ans_text = item.answer if item else ""
        candidates.append(
            ConfidenceCandidate(
                id=row["id"],
                confidence=row["confidence"],
                question=q_text,
            )
        )
        answers.append(
            CandidateAnswer(
                id=row["id"],
                confidence=row["confidence"],
                question=q_text,
                answer=ans_text,
            )
        )
        _log(f"[parse] candidate id={row['id']} confidence={row['confidence']:.3f}", "parse")

    if not candidates:
        _log("[parse] 未解析到有效候选", "parse")

    match = ConfidenceMatchResult(raw_output=raw_output, candidates=candidates)

    t_lookup0 = time.perf_counter()
    answer = answers[0].answer if answers else ""
    if answers:
        _log(f"[lookup] 取 Top1 answer len={len(answer)} id={answers[0].id}", "lookup")
    timings.lookup_ms = (time.perf_counter() - t_lookup0) * 1000.0
    timings.total_ms = (time.perf_counter() - t0) * 1000.0
    _log(f"[step] _run_confidence_match 完成 total={timings.total_ms:.1f}ms", "step")
    _log(_format_timings_log(timings), "timing")

    resp = ConfidenceAskResponse(
        question=question,
        kb_id=kb_id,
        match=match,
        answer=answer,
        answers=answers,
        timings=timings,
        cache_hit=True,
    )
    return match, timings, system_prompt, messages_dict, resp


def _llm_for_profile(profile: MatchProfile, settings: Settings) -> LLMClient:
    return LLMClient(settings).with_credentials(
        api_base_url=profile.api_base_url,
        api_key=profile.api_key,
    )


def create_app() -> FastAPI:
    """工厂函数：组装依赖、注册路由、挂载静态资源。模块级 app = create_app()。"""
    settings = Settings.load()
    kb_store = KbStore.open(settings.kb_config_path)
    models_store = ModelsStore.from_settings(settings)
    op_log = OperationLog(
        max_entries=5000,
        persist_path=settings.data_root / "logs" / "operations.jsonl",
    )
    prompts_path = settings.data_root / "config" / "prompts.json"
    cache_holder: dict[str, QuestionsCache] = {}

    def _on_prompts_change() -> None:
        c = cache_holder.get("cache")
        if c is not None:
            c.reload_all()

    prompts_store = PromptsStore.open(prompts_path, on_change=_on_prompts_change)
    cache = QuestionsCache(
        kb_store=kb_store,
        files_root=settings.files_root,
        confidence_top_k=settings.confidence_top_k,
        prompts_store=prompts_store,
    )
    cache_holder["cache"] = cache
    profiles_path = settings.data_root / "config" / "match_profiles.json"
    match_profiles_store = MatchProfilesStore.open(profiles_path, models_store=models_store)

    def llm_for_slot(slot: str) -> LLMClient:
        cfg = models_store.get_slot(slot)
        return LLMClient(settings).with_credentials(api_base_url=cfg.api_base_url, api_key=cfg.api_key)

    def resolve_match_profile(profile_id: str = "") -> MatchProfile:
        try:
            return match_profiles_store.get(profile_id)
        except KeyError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        """启动时预热所有知识库内存索引。"""
        cache.load_all()
        yield

    app = FastAPI(title="知识问答匹配系统", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.kb_store = kb_store
    app.state.cache = cache
    app.state.models_store = models_store
    app.state.match_profiles_store = match_profiles_store
    app.state.op_log = op_log
    app.state.prompts_store = prompts_store

    def _first_kb_id() -> str:
        ids = sorted(kb_store.get_all().keys(), key=lambda x: int(x) if str(x).isdigit() else x)
        return ids[0] if ids else ""

    web_root = (APP_ROOT / "web").resolve()
    if web_root.exists():
        app.mount("/static", StaticFiles(directory=str(web_root)), name="static")

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        """返回 Web 控制台 index.html。"""
        index_path = web_root / "index.html"
        if not index_path.exists():
            return HTMLResponse("<h1>knowledge_router</h1><p>web/index.html 缺失</p>")
        return HTMLResponse(index_path.read_text(encoding="utf-8"))

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        """探活接口，前端顶栏轮询。"""
        return HealthResponse()

    @app.post("/ask/confidence", response_model=ConfidenceAskResponse)
    def ask_confidence(req: ConfidenceAskRequest) -> ConfidenceAskResponse:
        """同步置信度问答：返回多候选 + Top1 answer。"""
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")
        kb_id = _validate_kb_id(kb_store, req.kb_id)
        profile = resolve_match_profile(req.match_profile_id)
        try:
            _, _, _, _, resp = _run_confidence_match(
                question=question,
                kb_id=kb_id,
                top_k=req.top_k,
                cache=cache,
                llm=_llm_for_profile(profile, settings),
                settings=settings,
                match_model=profile.model,
                max_tokens=profile.max_tokens,
                temperature=profile.temperature,
            )
            return resp
        except LLMError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

    @app.post("/ask/confidence/stream")
    def ask_confidence_stream(req: ConfidenceAskRequest) -> StreamingResponse:
        """流式置信度问答：SSE 推送 log -> candidates -> done。"""
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")
        kb_id = _validate_kb_id(kb_store, req.kb_id)
        top_k = req.top_k
        profile = resolve_match_profile(req.match_profile_id)

        def gen() -> Iterator[str]:
            log_q: queue.Queue[tuple[str, Any]] = queue.Queue()
            result_box: dict[str, Any] = {}
            error_box: list[LLMError] = []

            def emit_log(line: str, kind: str) -> None:
                log_q.put(("log", line, kind))

            def worker() -> None:
                sink = AskLogSink(emit=emit_log, op_log=op_log, module="debug", kb_id=kb_id)
                try:
                    sink.log("[step] POST /ask/confidence/stream 收到请求", "step")
                    sink.log(f"question: {question}", "log")
                    sink.log(f"kb_id: {kb_id} top_k: {top_k} profile: {profile.id}", "log")
                    match, timings, system_prompt, messages_dict, resp = _run_confidence_match(
                        question=question,
                        kb_id=kb_id,
                        top_k=top_k,
                        cache=cache,
                        llm=_llm_for_profile(profile, settings),
                        settings=settings,
                        log_sink=sink,
                        match_model=profile.model,
                        max_tokens=profile.max_tokens,
                        temperature=profile.temperature,
                    )
                    result_box["payload"] = (match, timings, system_prompt, messages_dict, resp)
                except LLMError as e:
                    error_box.append(e)
                finally:
                    log_q.put(("done", None))

            threading.Thread(target=worker, daemon=True).start()

            while True:
                try:
                    evt = log_q.get(timeout=0.05)
                except queue.Empty:
                    continue
                if evt[0] == "done":
                    break
                if evt[0] == "log":
                    yield _sse("log", {"line": evt[1], "kind": evt[2]})

            if error_box:
                yield _sse("error", {"detail": str(error_box[0])})
                return

            match, timings, system_prompt, messages_dict, resp = result_box["payload"]
            yield _sse(
                "candidates",
                {
                    "raw_output": match.raw_output,
                    "candidates": [c.model_dump() for c in match.candidates],
                    "enabled_count": cache.get_enabled_count(kb_id),
                    "messages": messages_dict,
                },
            )
            yield _sse(
                "done",
                {
                    "question": resp.question,
                    "kb_id": resp.kb_id,
                    "match": resp.match.model_dump(),
                    "answer": resp.answer,
                    "answers": [a.model_dump() for a in resp.answers],
                    "timings": resp.timings.model_dump(),
                    "cache_hit": resp.cache_hit,
                },
            )

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/knowledge-bases")
    def list_kbs() -> Dict[str, Any]:
        """列出所有知识库及 enabled_count。"""
        items = []
        for kb_id, cfg in kb_store.get_all().items():
            enabled_count = 0
            idx = cache.get_index(kb_id)
            if idx:
                enabled_count = len(idx.enabled_items)
            items.append({"kb_id": kb_id, **cfg, "enabled_count": enabled_count})
        return {"items": items}

    @app.post("/knowledge-bases")
    def create_kb(req: KnowledgeBaseCreateRequest) -> Dict[str, Any]:
        """创建知识库：写配置 + 空 questions.json + 建索引。"""
        kb_id = (req.kb_id or "").strip() or kb_store.next_available_kb_id()
        name = req.name.strip()
        try:
            cfg = kb_store.create_kb(kb_id=kb_id, name=name)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        kb_dir_path(settings.files_root, kb_id).mkdir(parents=True, exist_ok=True)
        kb_assets_dir_path(settings.files_root, kb_id).mkdir(parents=True, exist_ok=True)
        qpath = questions_json_path(settings.files_root, kb_id)
        if not qpath.exists():
            qpath.write_text(
                json.dumps({"version": 1, "items": []}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        cache.load_kb(kb_id)
        return {"kb_id": kb_id, **cfg}

    @app.get("/knowledge-bases/{kb_id}")
    def get_kb(kb_id: str) -> Dict[str, Any]:
        """获取单个知识库元数据。"""
        kid = _validate_kb_id(kb_store, kb_id)
        cfg = kb_store.get(kid)
        assert cfg is not None
        return {"kb_id": kid, **cfg, "enabled_count": cache.get_enabled_count(kid)}

    @app.delete("/knowledge-bases/{kb_id}")
    def delete_kb(kb_id: str) -> Dict[str, Any]:
        """删除知识库配置、磁盘目录与内存索引。"""
        kid = _validate_kb_id(kb_store, kb_id)
        try:
            cfg = kb_store.delete_kb(kb_id=kid)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        cache.evict_kb(kid)
        kb_store.delete_kb_files(kb_id=kid, files_root=settings.files_root)
        return {"kb_id": kid, **cfg}

    @app.post("/knowledge-bases/{kb_id}/rename")
    def rename_kb(kb_id: str, req: KnowledgeBaseRenameRequest) -> Dict[str, Any]:
        """重命名知识库。"""
        kid = _validate_kb_id(kb_store, kb_id)
        try:
            cfg = kb_store.rename_kb(kb_id=kid, name=req.name.strip())
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return {"kb_id": kid, **cfg}

    @app.get("/knowledge-bases/{kb_id}/confidence-prompt-preview", response_model=ConfidencePromptPreviewResponse)
    def confidence_prompt_preview(kb_id: str, top_k: int = Query(default=5, ge=1, le=20)) -> ConfidencePromptPreviewResponse:
        kid = _validate_kb_id(kb_store, kb_id)
        try:
            conf_rules, system_prompt, enabled_count = cache.preview_confidence_system_prompt(kid, top_k=top_k)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return ConfidencePromptPreviewResponse(
            kb_id=kid,
            confidence_match_prompt=conf_rules,
            system_prompt=system_prompt,
            enabled_count=enabled_count,
        )

    @app.post("/knowledge-bases/{kb_id}/reload")
    def reload_kb(kb_id: str) -> Dict[str, Any]:
        """手动重建内存索引（questions 外部修改后）。"""
        kid = _validate_kb_id(kb_store, kb_id)
        idx = cache.reload_kb(kid)
        return {
            "kb_id": kid,
            "loaded_at": idx.loaded_at,
            "enabled_count": len(idx.enabled_items),
        }

    @app.get("/knowledge-bases/{kb_id}/questions", response_model=QuestionsDocument)
    def get_questions(kb_id: str) -> QuestionsDocument:
        """读取整份 questions.json。"""
        kid = _validate_kb_id(kb_store, kb_id)
        return cache.store(kid).get_document()

    @app.put("/knowledge-bases/{kb_id}/questions", response_model=QuestionsDocument)
    def replace_questions(kb_id: str, req: QuestionsReplaceRequest) -> QuestionsDocument:
        """整库替换 FAQ 并 reload 索引。"""
        kid = _validate_kb_id(kb_store, kb_id)
        try:
            doc = cache.store(kid).replace_all(
                version=req.version,
                items=[item.model_dump() for item in req.items],
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        cache.reload_kb(kid)
        return doc

    @app.post("/knowledge-bases/{kb_id}/questions/items")
    def create_question_item(kb_id: str, req: QAItemUpsertRequest) -> Dict[str, Any]:
        """新增单条 FAQ（id 不可重复）。"""
        kid = _validate_kb_id(kb_store, kb_id)
        store = cache.store(kid)
        if store.get_item(req.id):
            raise HTTPException(status_code=400, detail="item id 已存在")
        try:
            item = store.upsert_item(item=req.model_dump())
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        cache.reload_kb(kid)
        op_log.append(module="manage", action="create_item", kb_id=kid, detail=f"item {req.id}")
        return item.model_dump()

    @app.put("/knowledge-bases/{kb_id}/questions/items/{item_id}")
    def update_question_item(kb_id: str, item_id: str, req: QAItemUpsertRequest) -> Dict[str, Any]:
        """更新单条 FAQ；路径 item_id 须与 body.id 一致。"""
        kid = _validate_kb_id(kb_store, kb_id)
        if req.id != item_id:
            raise HTTPException(status_code=400, detail="路径 item_id 与 body.id 不一致")
        store = cache.store(kid)
        if not store.get_item(item_id):
            raise HTTPException(status_code=404, detail="item_id 不存在")
        try:
            item = store.upsert_item(item=req.model_dump())
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        cache.reload_kb(kid)
        op_log.append(module="manage", action="update_item", kb_id=kid, detail=f"item {req.id}")
        return item.model_dump()

    @app.delete("/knowledge-bases/{kb_id}/questions/items/{item_id}")
    def delete_question_item(kb_id: str, item_id: str) -> Dict[str, Any]:
        """删除单条 FAQ。"""
        kid = _validate_kb_id(kb_store, kb_id)
        store = cache.store(kid)
        try:
            item = store.delete_item(item_id=item_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        cache.reload_kb(kid)
        op_log.append(module="manage", action="delete_item", kb_id=kid, detail=f"item {item_id}")
        return item.model_dump()

    @app.get("/preview-asset")
    def preview_asset(kb_id: str = Query(...), ref: str = Query(...)) -> FileResponse:
        """安全提供 kb assets 图片；ref 防路径穿越。"""
        kid = _validate_kb_id(kb_store, kb_id)
        r = (ref or "").strip().replace("\\", "/")
        if r.startswith("../"):
            r = r[3:]
        if r.startswith("assets/"):
            r = r[len("assets/") :]
        if ".." in Path(r).parts:
            raise HTTPException(status_code=400, detail="非法 ref")
        asset_path = (kb_assets_dir_path(settings.files_root, kid) / r).resolve()
        base = kb_assets_dir_path(settings.files_root, kid).resolve()
        if not str(asset_path).startswith(str(base)):
            raise HTTPException(status_code=400, detail="非法 ref")
        if not asset_path.exists():
            raise HTTPException(status_code=404, detail="资源不存在")
        return FileResponse(asset_path)

    @app.get("/documents/preview-asset")
    def preview_document_asset(ref: str = Query(...)) -> FileResponse:
        """documents/assets 下的插图预览。"""
        r = (ref or "").strip().replace("\\", "/")
        if r.startswith("../"):
            r = r[3:]
        if r.startswith("assets/"):
            r = r[len("assets/") :]
        if ".." in Path(r).parts:
            raise HTTPException(status_code=400, detail="非法 ref")
        asset_path = (documents_assets_dir_path(settings.files_root) / r).resolve()
        base = documents_assets_dir_path(settings.files_root).resolve()
        if not str(asset_path).startswith(str(base)):
            raise HTTPException(status_code=400, detail="非法 ref")
        if not asset_path.exists():
            raise HTTPException(status_code=404, detail="资源不存在")
        return FileResponse(asset_path)

    @app.get("/logs")
    def list_logs(
        limit: int = Query(default=500, ge=1, le=5000),
        module: str = Query(default=""),
        kb_id: str = Query(default=""),
        level: str = Query(default=""),
    ) -> Dict[str, Any]:
        items = op_log.list_entries(limit=limit, module=module, kb_id=kb_id, level=level)
        return {"items": items}

    @app.get("/logs/stream")
    def logs_stream(since: str = Query(default="")) -> StreamingResponse:
        def gen() -> Iterator[str]:
            last = since
            while True:
                batch = op_log.list_entries(limit=500)
                for entry in batch:
                    if entry.get("ts", "") > last:
                        yield _sse("log", entry)
                        last = entry.get("ts", last)
                time.sleep(1.0)

        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.delete("/logs")
    def clear_logs() -> Dict[str, Any]:
        n = op_log.clear()
        op_log.append(module="logs", action="clear", detail=f"cleared {n} entries")
        return {"cleared": n}

    @app.get("/settings/prompts")
    def get_global_prompts(kb_id: str = Query(default="")) -> Dict[str, Any]:
        """全局提示词 + 默认文案 + 运行时 system 预览。"""
        gp = prompts_store.get()
        preview_kb = (kb_id or "").strip() or _first_kb_id()
        top_k = settings.confidence_top_k
        defaults = all_default_prompts(top_k=top_k)
        conf_preview = ""
        conf_questions_section = ""
        enabled_count = 0
        if preview_kb:
            try:
                idx = cache.get_index(preview_kb)
                if idx is None:
                    idx = cache.load_kb(preview_kb)
                enabled_count = len(idx.enabled_items)
                conf_questions_section = build_question_list_section(idx.enabled_items)
                rules = gp.confidence_match_prompt.strip() or default_confidence_match_prompt(top_k=top_k)
                if "{top_k}" in rules:
                    rules = rules.format(top_k=top_k)
                conf_preview = f"{rules}\n\n{conf_questions_section}"
            except KeyError:
                pass
        faq_rules = gp.faq_generation_prompt.strip() or defaults["faq_generation_prompt"]
        vlm_rules = gp.pdf_vlm_prompt.strip() or defaults["pdf_vlm_prompt"]
        return {
            "confidence_match_prompt": gp.confidence_match_prompt,
            "faq_generation_prompt": gp.faq_generation_prompt,
            "pdf_vlm_prompt": gp.pdf_vlm_prompt,
            "updated_at": gp.updated_at,
            "preview_kb_id": preview_kb,
            "preview_top_k": top_k,
            "defaults": defaults,
            "confidence_system_preview": conf_preview,
            "confidence_questions_section": conf_questions_section,
            "faq_system_preview": faq_rules,
            "pdf_vlm_system_preview": vlm_rules,
            "enabled_count": enabled_count,
        }

    @app.put("/settings/prompts")
    def put_global_prompts(body: Dict[str, Any]) -> Dict[str, Any]:
        gp = prompts_store.set(
            confidence_match_prompt=body.get("confidence_match_prompt")
            if "confidence_match_prompt" in body
            else None,
            faq_generation_prompt=body.get("faq_generation_prompt")
            if "faq_generation_prompt" in body
            else None,
            pdf_vlm_prompt=body.get("pdf_vlm_prompt") if "pdf_vlm_prompt" in body else None,
        )
        op_log.append(module="settings", action="update_prompts", detail="更新回答模型提示词")
        preview_kb = _first_kb_id()
        top_k = settings.confidence_top_k
        defaults = all_default_prompts(top_k=top_k)
        conf_preview = ""
        conf_questions_section = ""
        if preview_kb:
            try:
                idx = cache.get_index(preview_kb)
                if idx is None:
                    idx = cache.load_kb(preview_kb)
                conf_questions_section = build_question_list_section(idx.enabled_items)
                rules = gp.confidence_match_prompt.strip() or default_confidence_match_prompt(top_k=top_k)
                if "{top_k}" in rules:
                    rules = rules.format(top_k=top_k)
                conf_preview = f"{rules}\n\n{conf_questions_section}"
            except KeyError:
                pass
        faq_rules = gp.faq_generation_prompt.strip() or defaults["faq_generation_prompt"]
        vlm_rules = gp.pdf_vlm_prompt.strip() or defaults["pdf_vlm_prompt"]
        return {
            "confidence_match_prompt": gp.confidence_match_prompt,
            "faq_generation_prompt": gp.faq_generation_prompt,
            "pdf_vlm_prompt": gp.pdf_vlm_prompt,
            "updated_at": gp.updated_at,
            "preview_kb_id": preview_kb,
            "preview_top_k": top_k,
            "defaults": defaults,
            "confidence_system_preview": conf_preview,
            "confidence_questions_section": conf_questions_section,
            "faq_system_preview": faq_rules,
            "pdf_vlm_system_preview": vlm_rules,
        }

    @app.get("/settings/match-profiles")
    def get_match_profiles() -> Dict[str, Any]:
        return {
            "default_id": match_profiles_store.get_default_id(),
            "profiles": match_profiles_store.list_profiles(mask_key=False),
        }

    @app.put("/settings/match-profiles")
    def put_match_profiles(body: Dict[str, Any]) -> Dict[str, Any]:
        updated = match_profiles_store.update_all(body)
        op_log.append(module="settings", action="update_match_profiles", detail="更新回答模型配置")
        return updated

    @app.get("/settings/models")
    def get_models_config() -> Dict[str, Any]:
        return {"slots": models_store.get_all(mask_key=False)}

    @app.put("/settings/models")
    def put_models_config(body: Dict[str, Any]) -> Dict[str, Any]:
        slots = body.get("slots") if isinstance(body.get("slots"), dict) else body
        updated = models_store.update_all(slots if isinstance(slots, dict) else {})
        op_log.append(module="settings", action="update_models", detail="更新模型配置")
        return {"slots": updated}

    @app.get("/knowledge-bases/{kb_id}/recall-tests", response_model=RecallTestDocument)
    def get_recall_tests(kb_id: str) -> RecallTestDocument:
        kid = _validate_kb_id(kb_store, kb_id)
        path = recall_tests_json_path(settings.files_root, kid)
        if not path.exists():
            return RecallTestDocument(items=[])
        data = json.loads(path.read_text(encoding="utf-8"))
        return RecallTestDocument.model_validate(data)

    @app.put("/knowledge-bases/{kb_id}/recall-tests", response_model=RecallTestDocument)
    def put_recall_tests(kb_id: str, doc: RecallTestDocument) -> RecallTestDocument:
        kid = _validate_kb_id(kb_store, kb_id)
        path = recall_tests_json_path(settings.files_root, kid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(doc.model_dump_json(indent=2), encoding="utf-8")
        op_log.append(module="debug", action="save_recall_tests", kb_id=kid, detail=f"{len(doc.items)} rows")
        return doc

    @app.get("/markdown-files/tree")
    def markdown_files_tree() -> Dict[str, Any]:
        return build_markdown_files_tree(settings.files_root)

    @app.get("/markdown-files/content")
    def markdown_files_content(path: str = Query(...)) -> Dict[str, Any]:
        try:
            return read_markdown_content(settings.files_root, path)
        except LLMError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @app.put("/markdown-files/content")
    def markdown_files_save(body: Dict[str, Any]) -> Dict[str, Any]:
        rel_path = str(body.get("path", "") or "").strip()
        markdown = str(body.get("markdown", "") or "")
        if not rel_path:
            raise HTTPException(status_code=400, detail="path 必填")
        try:
            result = save_markdown_content(settings.files_root, rel_path, markdown)
        except LLMError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        op_log.append(module="files", action="save", detail=rel_path)
        return result

    @app.delete("/markdown-files")
    def markdown_files_delete(path: str = Query(...)) -> Dict[str, Any]:
        try:
            result = delete_document_file(settings.files_root, path)
        except LLMError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        op_log.append(module="files", action="delete", detail=path)
        return result

    @app.put("/markdown-files/rename")
    def markdown_files_rename(body: Dict[str, Any]) -> Dict[str, Any]:
        rel_path = str(body.get("path", "") or "").strip()
        name = str(body.get("name", "") or "").strip()
        if not rel_path:
            raise HTTPException(status_code=400, detail="path 必填")
        try:
            result = rename_document_file(settings.files_root, rel_path, name)
        except LLMError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        op_log.append(module="files", action="rename", detail=f"{rel_path} -> {result.get('path', name)}")
        return result

    @app.post("/markdown-files")
    def markdown_files_create(body: Dict[str, Any]) -> Dict[str, Any]:
        name = str(body.get("name", "") or "").strip()
        markdown = str(body.get("markdown", "") or "")
        try:
            result = create_module_markdown(settings.files_root, name, markdown)
        except LLMError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        op_log.append(module="files", action="create", detail=result.get("path", name))
        return result

    @app.post("/documents/upload")
    async def documents_upload(file: UploadFile = File(...)) -> Dict[str, Any]:
        name = (file.filename or "upload").strip()
        if not name.lower().endswith((".pdf", ".md")):
            raise HTTPException(status_code=400, detail="仅支持 .pdf 或 .md 文件")
        dest_dir = documents_sources_dir_path(settings.files_root)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / Path(name).name
        content = await file.read()
        dest.write_bytes(content)
        meta: Dict[str, Any] = {"filename": dest.name, "size": len(content)}
        if dest.name.lower().endswith(".md"):
            try:
                meta["line_count"] = len(dest.read_text(encoding="utf-8").splitlines())
            except Exception:  # noqa: BLE001
                meta["line_count"] = 0
            meta["file_type"] = "md"
        else:
            meta["file_type"] = "pdf"
        op_log.append(module="files", action="upload", detail=f"uploaded {dest.name}")
        return meta

    @app.post("/documents/extract/stream")
    def documents_extract_stream(body: Dict[str, Any]) -> StreamingResponse:
        """SSE: 从 documents/sources 提取 PDF/Markdown。"""
        filename = str(body.get("filename", "") or "").strip()
        ranges = body.get("ranges") or []
        if not filename:
            raise HTTPException(status_code=400, detail="filename 必填")
        try:
            source_path = documents_source_path(settings.files_root, filename)
        except LLMError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        if not source_path.is_file():
            raise HTTPException(status_code=404, detail="源文件不存在")

        def run(emit: Callable[[str, str], None], log_q: queue.Queue) -> None:
            is_pdf = filename.lower().endswith(".pdf")
            is_md = filename.lower().endswith(".md")
            if not is_pdf and not is_md:
                raise LLMError("仅支持 PDF 或 Markdown 文件导入")
            norm_ranges = _normalize_import_ranges(ranges)
            if not norm_ranges:
                raise LLMError("请指定有效页码或行范围")
            pdf_vlm_cfg = models_store.get_slot("pdf_vlm")
            vlm_prompt = prompts_store.effective_pdf_vlm_prompt()
            emit_lock = threading.Lock()

            def on_progress(msg: str) -> None:
                with emit_lock:
                    emit(msg, "log")
                    op_log.append(module="files", action="step", detail=msg, kind="step")

            def extract_one(range_start: int, range_end: int) -> tuple[str, Dict[str, Any]]:
                if is_md:
                    merged_md, _out, stats = extract_markdown_range(
                        files_root=settings.files_root,
                        source_path=source_path,
                        line_start=range_start,
                        line_end=range_end,
                        on_progress=on_progress,
                        for_documents=True,
                    )
                else:
                    merged_md, _out, stats = extract_pdf_to_markdown(
                        files_root=settings.files_root,
                        source_path=source_path,
                        page_start=range_start,
                        page_end=range_end,
                        vlm_model=pdf_vlm_cfg.model,
                        vlm_system_prompt=vlm_prompt,
                        on_progress=on_progress,
                        for_documents=True,
                    )
                return merged_md, stats

            combined: Dict[str, Any] = {}
            last_md = ""

            if is_pdf and len(norm_ranges) > 1:
                emit(f"[step] 并发提取 {len(norm_ranges)} 个页码范围…", "step")
                with ThreadPoolExecutor(max_workers=min(len(norm_ranges), 4)) as pool:
                    futures = {
                        pool.submit(extract_one, s, e): (s, e) for s, e in norm_ranges
                    }
                    for fut in as_completed(futures):
                        s, e = futures[fut]
                        emit(f"[step] 完成 PDF 页 {s}-{e}", "step")
                        merged_md, stats = fut.result()
                        last_md = merged_md
                        combined = _merge_extract_stats(combined, stats)
            else:
                for range_start, range_end in norm_ranges:
                    label = "PDF 页" if is_pdf else "Markdown 行"
                    emit(f"[step] 开始提取 {label} {range_start}-{range_end}", "step")
                    merged_md, stats = extract_one(range_start, range_end)
                    last_md = merged_md
                    combined = _merge_extract_stats(combined, stats)

            emit(f"[step] 提取完成，共 {combined.get('line_count', 0)} 行", "step")
            log_q.put(
                (
                    "result",
                    {
                        "markdown": last_md,
                        "line_count": combined.get("line_count", 0),
                        "module_path": combined.get("module_path", ""),
                        "module_paths": combined.get("module_paths") or [],
                        "pages": combined.get("pages", 0),
                        "timings": combined.get("timings") or {},
                        "tokens": combined.get("tokens") or {},
                        "token_breakdown": combined.get("token_breakdown") or [],
                    },
                )
            )

        return _import_sse_response(run)

    def _commit_import_items(kid: str, raw_items: List[Dict[str, Any]], *, append: bool) -> int:
        store = cache.store(kid)
        doc = store.get_document()
        max_n = 0
        for it in doc.items:
            m = re.match(r"^q(\d+)$", it.id, re.I)
            if m:
                max_n = max(max_n, int(m.group(1)))
        numbered = assign_question_ids(raw_items, start=max_n + 1)
        added = 0
        for row in numbered:
            if store.get_item(row["id"]) and not append:
                continue
            store.upsert_item(
                item={
                    "id": row["id"],
                    "question": row["question"],
                    "variants": row.get("variants") or [],
                    "answer": row["answer"],
                    "enabled": True,
                }
            )
            added += 1
        cache.reload_kb(kid)
        return added

    def _import_sse_response(worker_fn: Callable[[Callable[[str, str], None], queue.Queue], None]) -> StreamingResponse:
        def gen() -> Iterator[str]:
            log_q: queue.Queue[tuple[str, Any]] = queue.Queue()

            def emit(line: str, kind: str = "log") -> None:
                log_q.put(("log", line, kind))

            def worker() -> None:
                try:
                    worker_fn(emit, log_q)
                except Exception as e:  # noqa: BLE001
                    log_q.put(("error", str(e)))
                finally:
                    log_q.put(("done", None))

            threading.Thread(target=worker, daemon=True).start()
            while True:
                try:
                    evt = log_q.get(timeout=0.05)
                except queue.Empty:
                    continue
                if evt[0] == "done":
                    break
                if evt[0] == "log":
                    yield _sse("log", {"line": evt[1], "kind": evt[2]})
                elif evt[0] == "error":
                    yield _sse("error", {"detail": evt[1]})
                elif evt[0] == "result":
                    yield _sse("done", evt[1])

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/knowledge-bases/{kb_id}/import/generate-questions")
    def import_generate_questions(kb_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """根据 answer 正文生成标准问题与变体问法。"""
        _validate_kb_id(kb_store, kb_id)
        answer_md = str(body.get("answer_md", "") or "").strip()
        if not answer_md:
            raise HTTPException(status_code=400, detail="answer_md 必填")
        import_cfg = models_store.get_slot("import")
        import_llm = llm_for_slot("import")
        faq_prompt = prompts_store.effective_faq_prompt()
        item, usage = generate_faq_questions_only(
            answer_md=answer_md,
            llm=import_llm,
            import_model=import_cfg.model,
            system_prompt=faq_prompt,
        )
        return {
            "question": item["question"],
            "variants": item.get("variants") or [],
            "tokens": usage.to_dict(),
        }

    @app.post("/knowledge-bases/{kb_id}/import/commit")
    def import_commit(kb_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """批量写入用户确认的 FAQ 条目。"""
        kid = _validate_kb_id(kb_store, kb_id)
        items = body.get("items") or []
        append = body.get("append", True)
        if not isinstance(items, list) or not items:
            raise HTTPException(status_code=400, detail="items 必填")
        raw_items: List[Dict[str, Any]] = []
        for row in items:
            if not isinstance(row, dict):
                continue
            question = str(row.get("question", "")).strip()
            answer = str(row.get("answer", "")).strip()
            if not question or not answer:
                continue
            variants_raw = row.get("variants") or []
            variants: List[str] = []
            if isinstance(variants_raw, list):
                for v in variants_raw:
                    s = str(v).strip()
                    if s and s not in variants:
                        variants.append(s)
            if not variants:
                variants = [question]
            raw_items.append({"question": question, "variants": variants[:3], "answer": answer})
        if not raw_items:
            raise HTTPException(status_code=400, detail="无有效条目")
        added = _commit_import_items(kid, raw_items, append=append)
        op_log.append(module="generate", action="commit", kb_id=kid, detail=f"imported {added} items")
        return {"added": added, "kb_id": kid}

    return app


app = create_app()  # uvicorn 入口：app.main:app
