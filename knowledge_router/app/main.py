"""
main.py — FastAPI 应用入口：HTTP API + 静态前端 + SSE 流式问答

职责：
  - create_app()：组装 Settings、KbStore、QuestionsStoreRegistry、QuestionsCache、LLMClient
  - lifespan：启动时 questions_cache.load_all()
  - POST /ask：同步问答（匹配 LLM → 内存取 answer）
  - POST /ask/stream：SSE（log / match_delta / match / done）
  - 知识库与 FAQ CRUD、preview-asset、health

问答主链路（/ask）：
  validate kb_id
  → questions_cache.get_enabled_candidates()   # 内存，不读盘
  → match_question() 或 stream                   # 匹配模型
  → questions_cache.get_item_by_id()           # O(1) 取预存 answer
  → AskResponse

阅读顺序：第 9 个（最后读，串联以上所有模块）
"""

from __future__ import annotations

import json
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Generator, List

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import APP_ROOT, Settings
from .kb_store import KbStore
from .llm_client import LLMClient, LLMError
from .matcher import (
    MATCH_SYSTEM_PROMPT_ZH,
    build_match_messages,
    match_question,
    no_candidates_result,
    parse_match_raw,
)
from .paths import kb_assets_dir_path, kb_dir_path
from .questions_cache import QuestionsCache
from .questions_store import QuestionsStoreRegistry
from .schemas import (
    AskRequest,
    AskResponse,
    AskTimings,
    CreateKnowledgeBaseRequest,
    HealthResponse,
    KnowledgeBaseSummary,
    KnowledgeBasesListResponse,
    QAItem,
    QAItemUpsertRequest,
    QuestionsDocument,
    QuestionsDocumentResponse,
    RenameKnowledgeBaseRequest,
    SetMatchPromptRequest,
)


def _sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _sse_log(level: str, message: str, detail: Any = None) -> str:
    payload: Dict[str, Any] = {"level": level, "message": message}
    if detail is not None:
        payload["detail"] = detail
    return _sse("log", payload)


def create_app() -> FastAPI:
    settings = Settings.load()
    kb_store = KbStore.open(settings.kb_config_path)
    questions_cache_holder: Dict[str, QuestionsCache] = {}

    def _on_questions_changed(kb_id: str) -> None:
        cache = questions_cache_holder.get("cache")
        if cache:
            cache.reload_kb(kb_id)

    store_registry = QuestionsStoreRegistry(files_root=settings.files_root, on_changed=_on_questions_changed)
    questions_cache = QuestionsCache(store_registry=store_registry)
    questions_cache_holder["cache"] = questions_cache
    llm = LLMClient(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        kb_ids = list(kb_store.get_all().keys())
        questions_cache.load_all(kb_ids)
        yield

    app = FastAPI(title="知识问答匹配系统", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.kb_store = kb_store
    app.state.store_registry = store_registry
    app.state.questions_cache = questions_cache
    app.state.llm = llm

    def _validate_kb_id(kb_id: str) -> str:
        kid = (kb_id or "").strip()
        if not kid:
            raise HTTPException(status_code=400, detail="kb_id 不能为空")
        if not kb_store.get(kid):
            raise HTTPException(status_code=404, detail="kb_id 不存在")
        return kid

    def _get_match_prompt(kb_id: str) -> str:
        cfg = kb_store.get(kb_id) or {}
        return str(cfg.get("match_prompt") or "")

    def _kb_summary(kb_id: str, cfg: Dict[str, Any]) -> KnowledgeBaseSummary:
        return KnowledgeBaseSummary(
            kb_id=kb_id,
            name=str(cfg.get("name") or kb_id),
            status=str(cfg.get("status") or "ready"),
            match_prompt=str(cfg.get("match_prompt") or ""),
            item_count=questions_cache.item_count(kb_id),
            enabled_count=questions_cache.enabled_count(kb_id),
            created_at=str(cfg.get("created_at") or ""),
            updated_at=str(cfg.get("updated_at") or ""),
        )

    def _resolve_asset(kb_id: str, ref: str) -> Path:
        kid = _validate_kb_id(kb_id)
        raw = (ref or "").strip().replace("\\", "/")
        if raw.startswith("../"):
            raw = raw[3:]
        if raw.startswith("assets/"):
            raw = raw[len("assets/") :]
        if ".." in raw or raw.startswith("/"):
            raise HTTPException(status_code=400, detail="非法 asset 路径")
        assets_dir = kb_assets_dir_path(settings.files_root, kid)
        resolved = (assets_dir / raw).resolve()
        if assets_dir.resolve() not in resolved.parents and resolved != assets_dir.resolve():
            raise HTTPException(status_code=403, detail="不允许访问该路径")
        if not resolved.is_file():
            raise HTTPException(status_code=404, detail="资源不存在")
        return resolved

    def _build_ask_response(
        *,
        question: str,
        kb_id: str,
        match_result,
        answer: str,
        citations: List,
        timings: AskTimings,
    ) -> AskResponse:
        index = questions_cache.get_index(kb_id)
        return AskResponse(
            question=question,
            kb_id=kb_id,
            match=match_result,
            answer=answer,
            citations=citations,
            timings=timings,
            cache_hit=True,
            enabled_count=len(index.enabled_items) if index else 0,
            kb_loaded_at=index.loaded_at if index else "",
        )

    web_root = (APP_ROOT / "web").resolve()
    if web_root.exists():
        app.mount("/static", StaticFiles(directory=str(web_root)), name="static")

        @app.get("/", response_class=HTMLResponse)
        def ui() -> HTMLResponse:
            return HTMLResponse(
                (web_root / "index.html").read_text(encoding="utf-8"),
                headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
            )

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse()

    @app.get("/knowledge-bases", response_model=KnowledgeBasesListResponse)
    def list_knowledge_bases() -> KnowledgeBasesListResponse:
        all_kb = kb_store.get_all()
        summaries = {kid: _kb_summary(kid, cfg) for kid, cfg in all_kb.items()}
        return KnowledgeBasesListResponse(knowledge_bases=summaries)

    @app.post("/knowledge-bases", response_model=KnowledgeBaseSummary)
    def create_knowledge_base(req: CreateKnowledgeBaseRequest) -> KnowledgeBaseSummary:
        kb_id = (req.kb_id or "").strip() or kb_store.next_available_kb_id()
        name = req.name.strip()
        try:
            cfg = kb_store.create_kb(kb_id=kb_id, name=name)
            kb_dir_path(settings.files_root, kb_id).mkdir(parents=True, exist_ok=True)
            kb_assets_dir_path(settings.files_root, kb_id).mkdir(parents=True, exist_ok=True)
            store_registry.for_kb(kb_id).replace_all({"version": 1, "items": []})
            questions_cache.load_kb(kb_id)
            return _kb_summary(kb_id, cfg)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @app.get("/knowledge-bases/{kb_id}", response_model=KnowledgeBaseSummary)
    def get_knowledge_base(kb_id: str) -> KnowledgeBaseSummary:
        kid = _validate_kb_id(kb_id)
        cfg = kb_store.get(kid) or {}
        return _kb_summary(kid, cfg)

    @app.delete("/knowledge-bases/{kb_id}", response_model=KnowledgeBaseSummary)
    def delete_knowledge_base(kb_id: str) -> KnowledgeBaseSummary:
        kid = _validate_kb_id(kb_id)
        try:
            cfg = kb_store.delete_kb(kb_id=kid)
            questions_cache.evict_kb(kid)
            kb_path = kb_dir_path(settings.files_root, kid)
            if kb_path.exists():
                shutil.rmtree(kb_path, ignore_errors=True)
            return _kb_summary(kid, cfg)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

    @app.post("/knowledge-bases/{kb_id}/rename", response_model=KnowledgeBaseSummary)
    def rename_knowledge_base(kb_id: str, req: RenameKnowledgeBaseRequest) -> KnowledgeBaseSummary:
        kid = _validate_kb_id(kb_id)
        try:
            cfg = kb_store.rename_kb(kb_id=kid, name=req.name.strip())
            return _kb_summary(kid, cfg)
        except (KeyError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @app.put("/knowledge-bases/{kb_id}/prompt", response_model=KnowledgeBaseSummary)
    def set_match_prompt(kb_id: str, req: SetMatchPromptRequest) -> KnowledgeBaseSummary:
        kid = _validate_kb_id(kb_id)
        try:
            cfg = kb_store.set_match_prompt(kb_id=kid, match_prompt=req.match_prompt)
            return _kb_summary(kid, cfg)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

    @app.get("/knowledge-bases/default-prompt")
    def default_match_prompt() -> Dict[str, str]:
        return {"match_prompt": MATCH_SYSTEM_PROMPT_ZH}

    @app.post("/knowledge-bases/{kb_id}/reload")
    def reload_knowledge_base(kb_id: str) -> Dict[str, Any]:
        kid = _validate_kb_id(kb_id)
        index = questions_cache.reload_kb(kid)
        return {
            "kb_id": kid,
            "loaded_at": index.loaded_at,
            "item_count": len(index.items_by_id),
            "enabled_count": len(index.enabled_items),
            "source_mtime": index.source_mtime,
        }

    @app.get("/knowledge-bases/{kb_id}/questions", response_model=QuestionsDocumentResponse)
    def get_questions_document(kb_id: str) -> QuestionsDocumentResponse:
        kid = _validate_kb_id(kb_id)
        items, loaded_at, source_mtime = questions_cache.get_document_snapshot(kid)
        doc = QuestionsDocument(version=1, items=items)
        return QuestionsDocumentResponse(
            kb_id=kid,
            document=doc,
            loaded_at=loaded_at,
            source_mtime=source_mtime,
        )

    @app.put("/knowledge-bases/{kb_id}/questions", response_model=QuestionsDocumentResponse)
    def replace_questions_document(kb_id: str, body: QuestionsDocument) -> QuestionsDocumentResponse:
        kid = _validate_kb_id(kb_id)
        try:
            store_registry.for_kb(kid).replace_all(body.model_dump(mode="json"))
            index = questions_cache.reload_kb(kid)
            items = list(index.items_by_id.values())
            return QuestionsDocumentResponse(
                kb_id=kid,
                document=QuestionsDocument(version=body.version or 1, items=items),
                loaded_at=index.loaded_at,
                source_mtime=index.source_mtime,
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @app.post("/knowledge-bases/{kb_id}/questions/items", response_model=QAItem)
    def create_question_item(kb_id: str, req: QAItemUpsertRequest) -> QAItem:
        kid = _validate_kb_id(kb_id)
        item = QAItem(**req.model_dump())
        try:
            return store_registry.for_kb(kid).upsert_item(item)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @app.put("/knowledge-bases/{kb_id}/questions/items/{item_id}", response_model=QAItem)
    def update_question_item(kb_id: str, item_id: str, req: QAItemUpsertRequest) -> QAItem:
        kid = _validate_kb_id(kb_id)
        if req.id.strip() != item_id.strip():
            raise HTTPException(status_code=400, detail="URL item_id 与 body.id 不一致")
        item = QAItem(**req.model_dump())
        try:
            return store_registry.for_kb(kid).upsert_item(item)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @app.delete("/knowledge-bases/{kb_id}/questions/items/{item_id}", response_model=QAItem)
    def delete_question_item(kb_id: str, item_id: str) -> QAItem:
        kid = _validate_kb_id(kb_id)
        try:
            return store_registry.for_kb(kid).delete_item(item_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

    @app.get("/preview-asset")
    def preview_asset(kb_id: str, ref: str) -> FileResponse:
        resolved = _resolve_asset(kb_id, ref)
        return FileResponse(resolved)

    @app.post("/ask", response_model=AskResponse)
    def ask(req: AskRequest) -> AskResponse:
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")
        kb_id = _validate_kb_id(req.kb_id)
        match_prompt = _get_match_prompt(kb_id)
        try:
            t_total0 = time.perf_counter()
            candidates = questions_cache.get_enabled_candidates(kb_id)
            index = questions_cache.get_index(kb_id)
            t_match0 = time.perf_counter()
            match_result = match_question(
                question=question,
                candidates=candidates,
                llm=llm,
                match_model=settings.match_model,
                match_prompt=match_prompt,
            )
            match_ms = (time.perf_counter() - t_match0) * 1000.0
            if match_result.need_clarification:
                total_ms = (time.perf_counter() - t_total0) * 1000.0
                return _build_ask_response(
                    question=question,
                    kb_id=kb_id,
                    match_result=match_result,
                    answer="",
                    citations=[],
                    timings=AskTimings(total_ms=total_ms, match_ms=match_ms, lookup_ms=0.0),
                )
            t_lookup0 = time.perf_counter()
            item = questions_cache.get_item_by_id(kb_id, match_result.matched_id)
            lookup_ms = (time.perf_counter() - t_lookup0) * 1000.0
            if not item:
                match_result = no_candidates_result()
                total_ms = (time.perf_counter() - t_total0) * 1000.0
                return _build_ask_response(
                    question=question,
                    kb_id=kb_id,
                    match_result=match_result,
                    answer="",
                    citations=[],
                    timings=AskTimings(total_ms=total_ms, match_ms=match_ms, lookup_ms=lookup_ms),
                )
            total_ms = (time.perf_counter() - t_total0) * 1000.0
            return _build_ask_response(
                question=question,
                kb_id=kb_id,
                match_result=match_result,
                answer=item.answer,
                citations=item.citations,
                timings=AskTimings(total_ms=total_ms, match_ms=match_ms, lookup_ms=lookup_ms),
            )
        except LLMError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

    @app.post("/ask/stream")
    def ask_stream(req: AskRequest) -> StreamingResponse:
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")
        kb_id = _validate_kb_id(req.kb_id)
        match_prompt = _get_match_prompt(kb_id)

        def generate() -> Generator[str, None, None]:
            try:
                t_total0 = time.perf_counter()
                index = questions_cache.get_index(kb_id)
                candidates = questions_cache.get_enabled_candidates(kb_id)
                yield _sse_log("info", f"开始处理提问（{len(question)} 字）· 知识库 {kb_id}")
                yield _sse_log(
                    "info",
                    "内存缓存已就绪",
                    {
                        "cache_hit": True,
                        "enabled_count": len(candidates),
                        "kb_loaded_at": index.loaded_at if index else "",
                        "source_mtime": index.source_mtime if index else 0,
                    },
                )
                if not candidates:
                    match_result = no_candidates_result()
                    yield _sse_log("warn", match_result.clarification_question)
                    total_ms = (time.perf_counter() - t_total0) * 1000.0
                    yield _sse(
                        "match",
                        {
                            "match": match_result.model_dump(mode="json"),
                            "timings": {"total_ms": total_ms, "match_ms": 0.0, "lookup_ms": 0.0},
                        },
                    )
                    yield _sse(
                        "done",
                        _build_ask_response(
                            question=question,
                            kb_id=kb_id,
                            match_result=match_result,
                            answer="",
                            citations=[],
                            timings=AskTimings(total_ms=total_ms),
                        ).model_dump(mode="json"),
                    )
                    return

                t_match0 = time.perf_counter()
                match_messages = build_match_messages(
                    question=question,
                    candidates=candidates,
                    match_prompt=match_prompt,
                )
                yield _sse_log(
                    "info",
                    "匹配 prompt 已构建",
                    {
                        "model": settings.match_model,
                        "candidate_count": len(candidates),
                        "messages": [
                            {"role": m.role, "content": m.content if isinstance(m.content, str) else m.content}
                            for m in match_messages
                        ],
                    },
                )
                yield _sse_log("match", f"调用匹配模型 {settings.match_model}")
                match_parts: List[str] = []
                match_first_token_ms: float | None = None
                for chunk in llm.chat_stream(model=settings.match_model, messages=match_messages):
                    if match_first_token_ms is None:
                        match_first_token_ms = (time.perf_counter() - t_total0) * 1000.0
                        yield _sse_log("match", f"匹配首字 · {match_first_token_ms:.0f} ms")
                    match_parts.append(chunk)
                    delta_payload: Dict[str, Any] = {"content": chunk}
                    if len(match_parts) == 1 and match_first_token_ms is not None:
                        delta_payload["match_first_token_ms"] = match_first_token_ms
                    yield _sse("match_delta", delta_payload)
                match_ms = (time.perf_counter() - t_match0) * 1000.0
                raw = "".join(match_parts)
                yield _sse_log(
                    "match",
                    f"匹配 JSON 解析 · {match_ms:.0f} ms",
                    {"raw": raw},
                )
                match_result = parse_match_raw(raw=raw, candidates=candidates)
                yield _sse(
                    "match",
                    {
                        "match": match_result.model_dump(mode="json"),
                        "timings": {
                            "match_ms": match_ms,
                            "match_first_token_ms": match_first_token_ms or 0.0,
                        },
                    },
                )
                if match_result.need_clarification:
                    yield _sse_log("warn", match_result.clarification_question or "需要澄清")
                    total_ms = (time.perf_counter() - t_total0) * 1000.0
                    yield _sse(
                        "done",
                        _build_ask_response(
                            question=question,
                            kb_id=kb_id,
                            match_result=match_result,
                            answer="",
                            citations=[],
                            timings=AskTimings(
                                total_ms=total_ms,
                                match_ms=match_ms,
                                match_first_token_ms=match_first_token_ms or 0.0,
                            ),
                        ).model_dump(mode="json"),
                    )
                    return

                t_lookup0 = time.perf_counter()
                item = questions_cache.get_item_by_id(kb_id, match_result.matched_id)
                lookup_ms = (time.perf_counter() - t_lookup0) * 1000.0
                yield _sse_log(
                    "ok",
                    f"内存查表命中 {match_result.matched_id} · lookup {lookup_ms:.3f} ms",
                    {"matched_question": match_result.matched_question},
                )
                if not item:
                    match_result = no_candidates_result()
                    total_ms = (time.perf_counter() - t_total0) * 1000.0
                    yield _sse(
                        "done",
                        _build_ask_response(
                            question=question,
                            kb_id=kb_id,
                            match_result=match_result,
                            answer="",
                            citations=[],
                            timings=AskTimings(
                                total_ms=total_ms,
                                match_ms=match_ms,
                                match_first_token_ms=match_first_token_ms or 0.0,
                                lookup_ms=lookup_ms,
                            ),
                        ).model_dump(mode="json"),
                    )
                    return

                total_ms = (time.perf_counter() - t_total0) * 1000.0
                response = _build_ask_response(
                    question=question,
                    kb_id=kb_id,
                    match_result=match_result,
                    answer=item.answer,
                    citations=item.citations,
                    timings=AskTimings(
                        total_ms=total_ms,
                        match_ms=match_ms,
                        match_first_token_ms=match_first_token_ms or 0.0,
                        lookup_ms=lookup_ms,
                    ),
                )
                yield _sse_log("ok", f"返回预存回答 · {len(item.answer)} 字")
                yield _sse("done", response.model_dump(mode="json"))
            except LLMError as e:
                yield _sse("error", {"message": str(e)})
            except Exception as e:  # noqa: BLE001
                yield _sse("error", {"message": f"{type(e).__name__}: {e}"})

        return StreamingResponse(generate(), media_type="text/event-stream")

    return app


app = create_app()
