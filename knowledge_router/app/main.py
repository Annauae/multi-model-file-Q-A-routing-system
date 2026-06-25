"""FastAPI 应用入口：问答 API、知识库 CRUD、静态 Web 控制台。

核心流程：
  单 id 匹配：_run_match -> parse_match_raw -> _finalize_ask（内存取 answer）
  置信度匹配：_run_confidence_match -> parse_confidence_raw -> Top1 answer
"""
from __future__ import annotations

import json
import queue
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import APP_ROOT, Settings
from .kb_store import KbStore
from .llm_client import ChatMessage, LLMClient, LLMError
from .matcher import (
    build_match_messages,
    count_question_prompt_lines,
    default_match_prompt,
    is_match_resolved,
    parse_confidence_raw,
    parse_match_raw,
)
from .paths import kb_assets_dir_path, kb_dir_path, questions_json_path
from .questions_cache import QuestionsCache
from .schemas import (
    AskRequest,
    AskResponse,
    AskTimings,
    ConfidenceAskRequest,
    ConfidenceAskResponse,
    ConfidenceCandidate,
    ConfidenceMatchResult,
    DefaultPromptResponse,
    HealthResponse,
    KnowledgeBaseCreateRequest,
    KnowledgeBaseRenameRequest,
    MatchPromptPreviewResponse,
    MatchPromptUpdateRequest,
    MatchResult,
    QAItemUpsertRequest,
    QuestionsDocument,
    QuestionsReplaceRequest,
)


def _sse(event: str, data: Dict[str, Any]) -> str:
    """格式化为 SSE 单条事件（event + data JSON）。"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def _format_timings_log(timings: AskTimings) -> str:
    """将 AskTimings 格式化为单行日志，供前端日志面板展示。"""
    return (
        f"[timing] 准备(索引+prompt)={timings.prepare_ms:.1f}ms "
        f"匹配(LLM)={timings.match_ms:.1f}ms "
        f"首token={timings.match_first_token_ms:.1f}ms "
        f"查表(取answer)={timings.lookup_ms:.2f}ms "
        f"总计={timings.total_ms:.1f}ms "
        f"输出tokens={timings.match_output_tokens}"
    )


class AskLogSink:
    """问答流水线日志收集器；可同步写入内存或实时 emit 到 SSE 队列。"""

    def __init__(self, *, emit: Callable[[str, str], None] | None = None) -> None:
        self._entries: List[tuple[str, str]] = []
        self._emit = emit  # 非空时每条 log 立即推给流式接口

    def log(self, line: str, kind: str = "log") -> None:
        """记录一行日志；kind 用于前端着色（step/match/prompt 等）。"""
        self._entries.append((line, kind))
        if self._emit is not None:
            self._emit(line, kind)

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


def _run_match(
    *,
    question: str,
    kb_id: str,
    cache: QuestionsCache,
    llm: LLMClient,
    settings: Settings,
    log_sink: AskLogSink | None = None,
    stream_log: List[str] | None = None,
) -> tuple[MatchResult, AskTimings, str, list[dict[str, str]]]:
    """执行单 id 匹配：加载索引 -> 流式 LLM -> 解析 id/NONE。

    Returns:
        match, timings, system_prompt, messages_dict（供 SSE 调试展示）
    """
    def _log(line: str, kind: str = "log") -> None:
        if log_sink is not None:
            log_sink.log(line, kind)
        if stream_log is not None:
            stream_log.append(line)

    timings = AskTimings()
    t0 = time.perf_counter()
    _log(f"[step] _run_match 开始 kb_id={kb_id}", "step")

    idx = cache.get_index(kb_id)
    if idx is None:
        _log("[cache] 内存索引未命中，执行 load_kb()", "cache")
        idx = cache.load_kb(kb_id)
    else:
        _log(f"[cache] 命中内存索引 loaded_at={idx.loaded_at}", "cache")

    prompt_lines = count_question_prompt_lines(idx.enabled_items)
    _log(
        f"[cache] enabled_items={len(idx.enabled_items)} prompt_lines={prompt_lines} "
        f"(含标准问题+variants)",
        "cache",
    )

    system_prompt = idx.match_system_prompt
    messages_dict = build_match_messages(system_prompt=system_prompt, user_question=question)
    messages = [ChatMessage(role=m["role"], content=m["content"]) for m in messages_dict]

    _log(f"[prompt] system 长度={len(system_prompt)} 字符", "prompt")
    _log(f"[prompt] system 内容:\n{system_prompt}", "prompt")
    _log(f"[prompt] user 消息（用户问题注入处）:\n{question}", "prompt")
    _log(
        f"[match] 调用 LLM model={settings.match_model} "
        f"max_tokens={settings.match_max_tokens} temperature={settings.match_temperature}",
        "match",
    )

    t_match0 = time.perf_counter()
    timings.prepare_ms = (t_match0 - t0) * 1000.0
    first_token_ms = 0.0
    buffer = ""
    got_first = False
    valid_ids = idx.valid_ids
    delta_count = 0

    def _early_stop(buf: str) -> bool:
        """流式早停：已输出合法 id 或 NONE 则不再等待后续 token。"""
        return is_match_resolved(buf, valid_ids)

    for delta in llm.chat_stream(
        model=settings.match_model,
        messages=messages,
        max_tokens=settings.match_max_tokens,
        temperature=settings.match_temperature,
        early_stop_check=_early_stop,
    ):
        delta_count += 1
        if not got_first:
            first_token_ms = (time.perf_counter() - t_match0) * 1000.0
            got_first = True
            _log(f"[match] 首 token 到达 +{first_token_ms:.1f}ms delta={delta!r}", "match")
        buffer += delta
        if is_match_resolved(buffer, valid_ids):
            _log(f"[match] 早停触发 buffer={buffer.strip()!r}", "match")
            break

    raw = buffer.strip()
    timings.match_ms = (time.perf_counter() - t_match0) * 1000.0
    timings.match_first_token_ms = first_token_ms
    timings.match_output_tokens = max(1, len(raw.split())) if raw else 0

    _log(f"[match] stream 结束 deltas={delta_count} raw_output={raw!r}", "match")

    match = parse_match_raw(raw=raw, valid_ids=idx.valid_ids)
    if match.need_clarification:
        _log("[parse] 未匹配或无效 id -> need_clarification=true", "parse")
    else:
        _log(f"[parse] 解析成功 matched_id={match.matched_id}", "parse")

    if match.matched_id:
        item = cache.resolve_item(kb_id, match.matched_id)
        if item:
            match.matched_question = item.question
            _log(f"[lookup] resolve_item({match.matched_id}) 命中标准问题={item.question!r}", "lookup")
        else:
            _log(f"[lookup] resolve_item({match.matched_id}) 未找到 enabled 条目", "lookup")

    timings.total_ms = (time.perf_counter() - t0) * 1000.0
    _log(f"[step] _run_match 完成 total={timings.total_ms:.1f}ms", "step")
    return match, timings, system_prompt, messages_dict


def _finalize_ask(
    *,
    question: str,
    kb_id: str,
    match: MatchResult,
    cache: QuestionsCache,
    timings: AskTimings,
    log_sink: AskLogSink | None = None,
) -> AskResponse:
    """匹配成功后从内存取预存 answer，不调用回答生成模型。"""
    def _log(line: str, kind: str = "log") -> None:
        if log_sink is not None:
            log_sink.log(line, kind)

    _log("[step] _finalize_ask 开始（内存取预存 answer，不调用回答模型）", "step")
    t_lookup0 = time.perf_counter()
    answer = ""
    if not match.need_clarification and match.matched_id:
        item = cache.resolve_item(kb_id, match.matched_id)
        if item:
            answer = item.answer
            _log(
                f"[lookup] 返回预存 answer len={len(answer)} cache_hit=true",
                "lookup",
            )
        else:
            match.need_clarification = True
            match.clarification_question = match.clarification_question or "匹配结果无效，请重试。"
            _log("[lookup] matched_id 无效，转为 need_clarification", "lookup")
    else:
        _log("[lookup] 跳过取 answer（未匹配）", "lookup")

    timings.lookup_ms = (time.perf_counter() - t_lookup0) * 1000.0
    timings.total_ms = timings.prepare_ms + timings.match_ms + timings.lookup_ms
    _log(f"[step] _finalize_ask 完成 lookup={timings.lookup_ms:.2f}ms total={timings.total_ms:.1f}ms", "step")
    _log(_format_timings_log(timings), "timing")
    return AskResponse(
        question=question,
        kb_id=kb_id,
        match=match,
        answer=answer if not match.need_clarification else "",
        timings=timings,
        cache_hit=True,
    )


def _run_confidence_match(
    *,
    question: str,
    kb_id: str,
    top_k: int,
    cache: QuestionsCache,
    llm: LLMClient,
    settings: Settings,
    log_sink: AskLogSink | None = None,
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
    _log(
        f"[match] 调用 LLM model={settings.match_model} "
        f"max_tokens={settings.confidence_max_tokens} temperature={settings.match_temperature}",
        "match",
    )

    t_match0 = time.perf_counter()
    timings.prepare_ms = (t_match0 - t0) * 1000.0
    first_token_ms = 0.0
    buffer = ""
    got_first = False
    delta_count = 0

    for delta in llm.chat_stream(
        model=settings.match_model,
        messages=messages,
        max_tokens=settings.confidence_max_tokens,
        temperature=settings.match_temperature,
        mock_mode="confidence",
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
    timings.match_output_tokens = max(1, len(raw.split())) if raw else 0
    _log(f"[match] stream 结束 deltas={delta_count} raw_output={raw!r}", "match")

    parsed, raw_output = parse_confidence_raw(raw=raw, valid_ids=idx.valid_ids, top_k=top_k)
    candidates: List[ConfidenceCandidate] = []
    for row in parsed:
        item = cache.resolve_item(kb_id, row["id"])
        candidates.append(
            ConfidenceCandidate(
                id=row["id"],
                confidence=row["confidence"],
                question=item.question if item else "",
            )
        )
        _log(f"[parse] candidate id={row['id']} confidence={row['confidence']:.3f}", "parse")

    if not candidates:
        _log("[parse] 未解析到有效候选", "parse")

    match = ConfidenceMatchResult(raw_output=raw_output, candidates=candidates)

    t_lookup0 = time.perf_counter()
    answer = ""
    if candidates:
        top_item = cache.resolve_item(kb_id, candidates[0].id)
        if top_item:
            answer = top_item.answer
            _log(f"[lookup] 取 Top1 answer len={len(answer)} id={candidates[0].id}", "lookup")
    timings.lookup_ms = (time.perf_counter() - t_lookup0) * 1000.0
    timings.total_ms = (time.perf_counter() - t0) * 1000.0
    _log(f"[step] _run_confidence_match 完成 total={timings.total_ms:.1f}ms", "step")
    _log(_format_timings_log(timings), "timing")

    resp = ConfidenceAskResponse(
        question=question,
        kb_id=kb_id,
        match=match,
        answer=answer,
        timings=timings,
        cache_hit=True,
    )
    return match, timings, system_prompt, messages_dict, resp


def create_app() -> FastAPI:
    """工厂函数：组装依赖、注册路由、挂载静态资源。模块级 app = create_app()。"""
    settings = Settings.load()
    kb_store = KbStore.open(settings.kb_config_path)
    cache = QuestionsCache(
        kb_store=kb_store,
        files_root=settings.files_root,
        confidence_top_k=settings.confidence_top_k,
    )
    llm = LLMClient(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        """启动时预热所有知识库内存索引。"""
        cache.load_all()
        yield

    app = FastAPI(title="知识问答匹配系统", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.kb_store = kb_store
    app.state.cache = cache
    app.state.llm = llm

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

    @app.post("/ask", response_model=AskResponse)
    def ask(req: AskRequest) -> AskResponse:
        """同步单 id 问答：匹配 + 取预存 answer。"""
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")
        kb_id = _validate_kb_id(kb_store, req.kb_id)
        try:
            match, timings, _, _ = _run_match(
                question=question,
                kb_id=kb_id,
                cache=cache,
                llm=llm,
                settings=settings,
            )
            return _finalize_ask(
                question=question,
                kb_id=kb_id,
                match=match,
                cache=cache,
                timings=timings,
            )
        except LLMError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

    @app.post("/ask/stream")
    def ask_stream(req: AskRequest) -> StreamingResponse:
        """流式单 id 问答：SSE 推送 log -> match -> done。"""
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")
        kb_id = _validate_kb_id(kb_store, req.kb_id)

        def gen() -> Iterator[str]:
            log_q: queue.Queue[tuple[str, Any]] = queue.Queue()
            result_box: dict[str, Any] = {}
            error_box: list[LLMError] = []

            def emit_log(line: str, kind: str) -> None:
                log_q.put(("log", line, kind))

            def worker() -> None:
                """后台线程跑匹配，避免阻塞 SSE 生成器。"""
                sink = AskLogSink(emit=emit_log)
                try:
                    sink.log("[step] POST /ask/stream 收到请求", "step")
                    sink.log(f"question: {question}", "log")
                    sink.log(f"kb_id: {kb_id}", "log")
                    match, timings, system_prompt, messages_dict = _run_match(
                        question=question,
                        kb_id=kb_id,
                        cache=cache,
                        llm=llm,
                        settings=settings,
                        log_sink=sink,
                    )
                    resp = _finalize_ask(
                        question=question,
                        kb_id=kb_id,
                        match=match,
                        cache=cache,
                        timings=timings,
                        log_sink=sink,
                    )
                    sink.log("[step] 推送 match / done 事件到前端", "step")
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
                "match",
                {
                    "raw_output": match.raw_output,
                    "matched_id": match.matched_id,
                    "matched_question": match.matched_question,
                    "need_clarification": match.need_clarification,
                    "clarification_question": match.clarification_question,
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
                    "timings": resp.timings.model_dump(),
                    "cache_hit": resp.cache_hit,
                },
            )

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/ask/confidence", response_model=ConfidenceAskResponse)
    def ask_confidence(req: ConfidenceAskRequest) -> ConfidenceAskResponse:
        """同步置信度问答：返回多候选 + Top1 answer。"""
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")
        kb_id = _validate_kb_id(kb_store, req.kb_id)
        top_k = req.top_k
        try:
            _, _, _, _, resp = _run_confidence_match(
                question=question,
                kb_id=kb_id,
                top_k=top_k,
                cache=cache,
                llm=llm,
                settings=settings,
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

        def gen() -> Iterator[str]:
            log_q: queue.Queue[tuple[str, Any]] = queue.Queue()
            result_box: dict[str, Any] = {}
            error_box: list[LLMError] = []

            def emit_log(line: str, kind: str) -> None:
                log_q.put(("log", line, kind))

            def worker() -> None:
                sink = AskLogSink(emit=emit_log)
                try:
                    sink.log("[step] POST /ask/confidence/stream 收到请求", "step")
                    sink.log(f"question: {question}", "log")
                    sink.log(f"kb_id: {kb_id} top_k: {top_k}", "log")
                    match, timings, system_prompt, messages_dict, resp = _run_confidence_match(
                        question=question,
                        kb_id=kb_id,
                        top_k=top_k,
                        cache=cache,
                        llm=llm,
                        settings=settings,
                        log_sink=sink,
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

    @app.put("/knowledge-bases/{kb_id}/prompt")
    def update_prompt(kb_id: str, req: MatchPromptUpdateRequest) -> Dict[str, Any]:
        """更新 match_prompt 并 reload 索引。"""
        kid = _validate_kb_id(kb_store, kb_id)
        try:
            cfg = kb_store.set_match_prompt(kb_id=kid, match_prompt=req.match_prompt)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        cache.reload_kb(kid)
        return {"kb_id": kid, **cfg}

    @app.get("/knowledge-bases/default-prompt", response_model=DefaultPromptResponse)
    def default_prompt() -> DefaultPromptResponse:
        """返回内置默认单 id 匹配规则。"""
        return DefaultPromptResponse(match_prompt=default_match_prompt())

    @app.get("/knowledge-bases/{kb_id}/match-prompt-preview", response_model=MatchPromptPreviewResponse)
    def match_prompt_preview(kb_id: str) -> MatchPromptPreviewResponse:
        """管理页：预览规则 + 完整 system prompt。"""
        kid = _validate_kb_id(kb_store, kb_id)
        try:
            match_prompt, system_prompt, enabled_count = cache.preview_system_prompt(kid)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        return MatchPromptPreviewResponse(
            kb_id=kid,
            match_prompt=match_prompt,
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

    return app


app = create_app()  # uvicorn 入口：app.main:app
