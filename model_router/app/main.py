from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .agent_sync import sync_agent_from_files, sync_all_agents_from_files
from .agent_runner import (
    _citations_to_illustrations,
    finalize_streamed_agent_answer,
    run_agents,
    stream_single_agent_answer,
    summarize_agent_prepare,
)
from .file_loader import SUPPORTED_EXTS, expand_agent_file_list, list_supported_files_in_dir, load_agent_files
from .agents_store import AgentsStore
from .batch_evaluator import evaluate_answer_accuracy
from .batch_import import parse_batch_import_text
from .batch_tests_store import BatchTestsStore
from .config import APP_ROOT, Settings
from .initializer import generate_route_questions_and_summaries
from .llm_client import LLMClient, LLMError
from .knowledge_loader import (
    build_answer_system_content,
    agent_files_dir,
    resolve_agent_knowledge,
    resolve_knowledge_asset_path,
    format_system_content_for_log,
    count_system_images,
)
from .router import (
    build_route_messages,
    get_eligible_agents,
    no_agents_router_result,
    parse_route_raw,
    route_question,
)
from .schemas import (
    AgentResponse,
    AgentsResponse,
    AskRequest,
    AskResponse,
    CreateAgentRequest,
    CreateFileRequest,
    FileTreeNode,
    FileTreeResponse,
    FileWriteResponse,
    AutoCreateAgentResponse,
    BatchTestItem,
    BatchTestResponse,
    BatchTestRunResponse,
    BatchTestsListResponse,
    CreateBatchTestRequest,
    ImportBatchTestsRequest,
    ImportBatchTestsResponse,
    RenameAgentRequest,
    RenameFileRequest,
    UpdateBatchTestRequest,
    WriteFileRequest,
    FileTextPreviewResponse,
    AgentContextPreviewResponse,
    AgentFileEntry,
    AgentFilesListResponse,
    FileRawResponse,
    HealthResponse,
    InitializeResponse,
    RegisterFilesRequest,
    SyncAgentsResponse,
    UpdateAgentInstructionsRequest,
    UpdateAgentKnowledgeRequest,
    UpdateAgentPromptRequest,
)


def _sanitize_filename(name: str) -> str:
    # minimal safeguard; keep user-friendly names
    name = (name or "").strip().replace("\\", "_").replace("/", "_")
    if not name:
        return "uploaded_file"
    return name


def _agent_folder_name(agent_id: str) -> str:
    return f"agent_{agent_id}"


def _ensure_agent_folder(settings: Settings, agent_id: str, *, create_knowledge: bool = False) -> Path:
    agent_dir = (settings.files_root / _agent_folder_name(agent_id)).resolve()
    agent_dir.mkdir(parents=True, exist_ok=True)
    if create_knowledge:
        knowledge = agent_dir / "knowledge.md"
        if not knowledge.is_file():
            knowledge.write_text("", encoding="utf-8")
    return agent_dir


def _sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _sse_log(level: str, message: str, detail: Any = None) -> str:
    payload: Dict[str, Any] = {"level": level, "message": message}
    if detail is not None:
        payload["detail"] = detail
    return _sse("log", payload)


def _batch_item_model(raw: Dict[str, Any]) -> BatchTestItem:
    return BatchTestItem.model_validate(raw)


def create_app() -> FastAPI:
    settings = Settings.load()
    store = AgentsStore.open(settings.agents_config_path)
    batch_store = BatchTestsStore.open(settings.batch_tests_config_path)
    llm = LLMClient(settings)

    app = FastAPI(title="多模型文件问答调度系统", version="0.1.0")
    app.state.settings = settings
    app.state.store = store
    app.state.batch_store = batch_store
    app.state.llm = llm

    web_root = (APP_ROOT / "web").resolve()
    if web_root.exists():
        app.mount("/static", StaticFiles(directory=str(web_root)), name="static")

        @app.get("/", response_class=HTMLResponse)
        def ui() -> HTMLResponse:
            return HTMLResponse(
                (web_root / "index.html").read_text(encoding="utf-8"),
                headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
            )

    def _resolve_files_root_path(file: str) -> Path:
        p = Path(file)
        resolved = p.resolve() if p.is_absolute() else (settings.data_root / p).resolve()
        files_root = settings.files_root.resolve()
        if resolved != files_root and files_root not in resolved.parents:
            raise HTTPException(status_code=403, detail="不允许访问该路径（仅支持 files/ 目录下的文件）")
        if resolved.suffix.lower() not in SUPPORTED_EXTS:
            raise HTTPException(status_code=400, detail=f"不支持的文件类型：{resolved.suffix}")
        if not resolved.exists():
            raise HTTPException(status_code=404, detail="文件不存在")
        return resolved

    _EDITABLE_TEXT_EXTS = {".md", ".txt"}

    def _resolve_files_path(
        file: str,
        *,
        must_exist: bool = True,
        allowed_suffixes: set[str] | None = None,
    ) -> Path:
        p = Path(file)
        resolved = p.resolve() if p.is_absolute() else (settings.data_root / p).resolve()
        files_root = settings.files_root.resolve()
        if resolved != files_root and files_root not in resolved.parents:
            raise HTTPException(status_code=403, detail="不允许访问该路径（仅支持 files/ 目录下的文件）")
        suffixes = allowed_suffixes if allowed_suffixes is not None else SUPPORTED_EXTS
        if resolved.suffix.lower() not in suffixes:
            raise HTTPException(status_code=400, detail=f"不支持的文件类型：{resolved.suffix}")
        if must_exist and not resolved.exists():
            raise HTTPException(status_code=404, detail="文件不存在")
        return resolved

    def _rel_files_path(path: Path) -> str:
        try:
            return path.relative_to(settings.data_root.resolve()).as_posix()
        except Exception:
            return str(path)

    def _build_file_tree(root_path: Path) -> List[FileTreeNode]:
        if not root_path.exists():
            return []
        nodes: List[FileTreeNode] = []

        def walk(dir_path: Path) -> List[FileTreeNode]:
            items: List[FileTreeNode] = []
            try:
                children = sorted(dir_path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
            except OSError:
                return items
            for child in children:
                if child.name.startswith("."):
                    continue
                rel = _rel_files_path(child)
                if child.is_dir():
                    items.append(
                        FileTreeNode(
                            name=child.name,
                            path=rel,
                            type="dir",
                            children=walk(child),
                        )
                    )
                else:
                    items.append(FileTreeNode(name=child.name, path=rel, type="file", children=[]))
            return items

        if root_path.is_dir():
            nodes = walk(root_path)
        elif root_path.is_file():
            nodes = [FileTreeNode(name=root_path.name, path=_rel_files_path(root_path), type="file", children=[])]
        return nodes

    def _resolve_files_dir(path_str: str, *, must_exist: bool = True) -> Path:
        p = Path(path_str)
        resolved = p.resolve() if p.is_absolute() else (settings.data_root / p).resolve()
        files_root = settings.files_root.resolve()
        if resolved != files_root and files_root not in resolved.parents:
            raise HTTPException(status_code=403, detail="不允许访问该路径（仅支持 files/ 目录下的文件）")
        if must_exist and not resolved.exists():
            raise HTTPException(status_code=404, detail="目录不存在")
        if must_exist and not resolved.is_dir():
            raise HTTPException(status_code=400, detail="路径必须是目录")
        return resolved

    _PREVIEW_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    _PREVIEW_VIDEO_EXTS = {".mp4", ".webm", ".mov"}
    _PREVIEW_MEDIA_EXTS = _PREVIEW_IMAGE_EXTS | _PREVIEW_VIDEO_EXTS

    _MEDIA_TYPES = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
    }

    def _resolve_preview_image_path(file: str) -> Path:
        p = Path(file)
        resolved = p.resolve() if p.is_absolute() else (settings.data_root / p).resolve()
        files_root = settings.files_root.resolve()
        if resolved != files_root and files_root not in resolved.parents:
            raise HTTPException(status_code=403, detail="不允许访问该路径（仅支持 files/ 目录下的文件）")
        if resolved.suffix.lower() not in _PREVIEW_IMAGE_EXTS:
            raise HTTPException(status_code=400, detail=f"不支持的图片类型：{resolved.suffix}")
        if not resolved.exists():
            raise HTTPException(status_code=404, detail="文件不存在")
        return resolved

    def _resolve_preview_pdf_path(file: str) -> Path:
        resolved = _resolve_files_root_path(file)
        if resolved.suffix.lower() != ".pdf":
            raise HTTPException(status_code=400, detail="仅支持 PDF 预览")
        return resolved

    @app.get("/preview-image")
    def preview_image(
        file: str = Query(..., description="图片路径（相对 data_root，且必须在 files/ 下）"),
    ) -> FileResponse:
        """返回 knowledge.md 中引用的 PNG/JPG 等静态图片。"""
        image_path = _resolve_preview_image_path(file)
        media = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(image_path.suffix.lower(), "application/octet-stream")
        return FileResponse(path=str(image_path), media_type=media)

    def _media_response(path: Path) -> FileResponse:
        media = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
        return FileResponse(path=str(path), media_type=media)

    def _resolve_preview_media_path(file: str) -> Path:
        p = Path(file)
        resolved = p.resolve() if p.is_absolute() else (settings.data_root / p).resolve()
        files_root = settings.files_root.resolve()
        if resolved != files_root and files_root not in resolved.parents:
            raise HTTPException(status_code=403, detail="不允许访问该路径（仅支持 files/ 目录下的文件）")
        if resolved.suffix.lower() not in _PREVIEW_MEDIA_EXTS:
            raise HTTPException(status_code=400, detail=f"不支持的媒体类型：{resolved.suffix}")
        if not resolved.exists():
            raise HTTPException(status_code=404, detail="文件不存在")
        return resolved

    @app.get("/preview-media")
    def preview_media(
        file: str = Query(..., description="媒体路径（相对 data_root，且必须在 files/ 下）"),
    ) -> FileResponse:
        """返回 files/ 下的 MP4/WebM/MOV 等视频文件。"""
        media_path = _resolve_preview_media_path(file)
        if media_path.suffix.lower() not in _PREVIEW_VIDEO_EXTS:
            raise HTTPException(status_code=400, detail="仅支持视频文件")
        return _media_response(media_path)

    @app.get("/preview-asset")
    def preview_asset(
        source: str = Query(..., description="Markdown 源文件路径（如 files/agent_1/knowledge.md）"),
        ref: str = Query(..., description="MD 内相对引用（如 assets/foo.png）"),
    ) -> FileResponse:
        """解析 MD 内图片/视频相对路径并返回媒体文件。"""
        source_path = _resolve_files_root_path(source)
        if source_path.suffix.lower() not in {".md", ".txt"}:
            raise HTTPException(status_code=400, detail="source 必须是 .md 或 .txt 文件")

        files_dir = ""
        parts = source_path.as_posix().split("/")
        for i, part in enumerate(parts):
            if part.startswith("agent_"):
                agent_id = part.replace("agent_", "", 1)
                files_dir = agent_files_dir(agent_id)
                break
        if not files_dir:
            try:
                rel = source_path.parent.relative_to(settings.files_root.resolve())
                files_dir = f"files/{rel.as_posix()}"
            except Exception:
                files_dir = str(source_path.parent)

        resolved = resolve_knowledge_asset_path(
            project_root=settings.data_root,
            files_dir=files_dir,
            asset_ref=ref,
        )
        if not resolved:
            raise HTTPException(status_code=404, detail=f"无法解析资源引用：{ref}")
        asset_path = _resolve_preview_media_path(resolved)
        return _media_response(asset_path)

    @app.get("/files/raw", response_model=FileRawResponse)
    def read_raw_file(
        file: str = Query(..., description="文件路径（相对 data_root，且必须在 files/ 下）"),
    ) -> FileRawResponse:
        resolved = _resolve_files_root_path(file)
        if resolved.suffix.lower() not in _EDITABLE_TEXT_EXTS:
            raise HTTPException(status_code=400, detail="仅支持 .md / .txt 原始文本预览")
        text = resolved.read_text(encoding="utf-8", errors="ignore")
        return FileRawResponse(file=file, text=text, char_count=len(text))

    @app.put("/files/raw", response_model=FileWriteResponse)
    def write_raw_file(req: WriteFileRequest) -> FileWriteResponse:
        resolved = _resolve_files_path(
            req.file,
            must_exist=False,
            allowed_suffixes=_EDITABLE_TEXT_EXTS,
        )
        resolved.parent.mkdir(parents=True, exist_ok=True)
        text = req.text if req.text is not None else ""
        resolved.write_text(text, encoding="utf-8")
        rel = _rel_files_path(resolved)
        return FileWriteResponse(file=rel, char_count=len(text))

    @app.post("/files", response_model=FileWriteResponse)
    def create_file(req: CreateFileRequest) -> FileWriteResponse:
        resolved = _resolve_files_path(
            req.file,
            must_exist=False,
            allowed_suffixes=_EDITABLE_TEXT_EXTS,
        )
        if resolved.exists():
            raise HTTPException(status_code=409, detail="文件已存在")
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text("", encoding="utf-8")
        rel = _rel_files_path(resolved)
        return FileWriteResponse(file=rel, char_count=0)

    @app.delete("/files")
    def delete_file(
        file: str = Query(..., description="文件路径（相对 data_root，且必须在 files/ 下）"),
    ) -> Dict[str, str]:
        resolved = _resolve_files_path(file, must_exist=True, allowed_suffixes=SUPPORTED_EXTS | _PREVIEW_IMAGE_EXTS)
        if resolved.is_dir():
            raise HTTPException(status_code=400, detail="暂不支持删除目录")
        resolved.unlink(missing_ok=False)
        return {"file": _rel_files_path(resolved), "status": "deleted"}

    @app.post("/files/rename")
    def rename_file(req: RenameFileRequest) -> Dict[str, str]:
        src = _resolve_files_path(req.from_path, must_exist=True, allowed_suffixes=SUPPORTED_EXTS | _PREVIEW_IMAGE_EXTS)
        dst = _resolve_files_path(req.to_path, must_exist=False, allowed_suffixes=SUPPORTED_EXTS | _PREVIEW_IMAGE_EXTS)
        if dst.exists():
            raise HTTPException(status_code=409, detail="目标路径已存在")
        dst.parent.mkdir(parents=True, exist_ok=True)
        from_rel = _rel_files_path(src)
        src.rename(dst)
        return {"from": from_rel, "to": _rel_files_path(dst)}

    @app.get("/files/tree", response_model=FileTreeResponse)
    def list_files_tree(
        root: str = Query("files", description="目录根路径（相对 data_root，必须在 files/ 下）"),
    ) -> FileTreeResponse:
        resolved = _resolve_files_dir(root, must_exist=True)
        rel_root = _rel_files_path(resolved)
        return FileTreeResponse(root=rel_root, tree=_build_file_tree(resolved))

    @app.get("/agents/files", response_model=AgentFilesListResponse)
    def list_all_agent_files() -> AgentFilesListResponse:
        entries: List[AgentFileEntry] = []
        for agent_id in sorted(store.get_all().keys(), key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0, x)):
            files_dir = agent_files_dir(agent_id)
            file_paths, _errors = list_supported_files_in_dir(
                project_root=settings.data_root,
                files_dir=files_dir,
                recursive=False,
            )
            folder = _agent_folder_name(agent_id)
            for path in file_paths:
                name = Path(path).name
                entries.append(
                    AgentFileEntry(
                        agent_id=agent_id,
                        path=path,
                        label=f"{folder}/{name}",
                    )
                )
        return AgentFilesListResponse(files=entries)

    @app.get("/preview-text", response_model=FileTextPreviewResponse)
    def preview_extracted_text(
        file: str = Query(..., description="文件路径（相对 data_root，且必须在 files/ 下）"),
    ) -> FileTextPreviewResponse:
        """预览单个文件提取后的文本（与 /ask 回答阶段读取方式一致）。"""
        _resolve_files_root_path(file)
        loaded = load_agent_files(
            project_root=settings.data_root,
            file_paths=[file],
            max_file_chars=settings.max_file_chars,
        )
        text = loaded.context
        truncated = bool(loaded.context_note)
        return FileTextPreviewResponse(
            file=file,
            text=text,
            char_count=len(text),
            truncated=truncated,
            context_note=loaded.context_note,
            file_errors=loaded.file_errors,
        )

    @app.get("/agents/{agent_id}/preview-context", response_model=AgentContextPreviewResponse)
    def preview_agent_context(agent_id: str) -> AgentContextPreviewResponse:
        """预览某 agent 在 /ask 时使用的完整 system 消息（固定模板 + 知识内容）。"""
        cfg = store.get(agent_id)
        if not cfg:
            raise HTTPException(status_code=404, detail="agent_id 不存在")

        files_dir = agent_files_dir(agent_id)
        configured_knowledge = str(cfg.get("knowledge", "") or cfg.get("answer_prompt", "") or "")
        answer_instructions = str(cfg.get("answer_instructions", "") or "")
        knowledge_text, knowledge_source, context_note = resolve_agent_knowledge(
            project_root=settings.data_root,
            agent_id=agent_id,
            configured_knowledge=configured_knowledge,
            max_chars=settings.max_file_chars,
        )
        system_content: str | list = ""
        if knowledge_text:
            system_content = build_answer_system_content(
                agent_name=str(cfg.get("name", agent_id)),
                knowledge=knowledge_text,
                knowledge_source=knowledge_source,
                answer_instructions=answer_instructions,
                project_root=settings.data_root,
                files_dir=files_dir,
                max_answer_chars=settings.max_answer_chars,
                include_images=settings.answer_with_images,
                max_images=settings.max_answer_images,
            )
        system_message = format_system_content_for_log(system_content) if system_content else ""
        return AgentContextPreviewResponse(
            agent_id=agent_id,
            agent_name=str(cfg.get("name", agent_id)),
            used_files=[knowledge_source] if knowledge_source else [],
            context=system_message,
            char_count=len(system_message),
            truncated=bool(context_note),
            context_note=(
                (context_note or "")
                + (
                    f"；system 含 {count_system_images(system_content)} 张插图"
                    if system_content and count_system_images(system_content)
                    else ""
                )
            ).strip("；") or None,
            file_errors=[] if knowledge_text else ["知识内容为空"],
        )

    @app.get("/preview")
    def preview_pdf_page(
        file: str = Query(..., description="PDF 文件路径（相对 data_root，且必须在 files/ 下）"),
        page: int = Query(1, ge=1, description="页码（从 1 开始）"),
        zoom: float = Query(2.0, ge=0.5, le=4.0, description="渲染缩放倍数"),
    ) -> Response:
        pdf_path = _resolve_preview_pdf_path(file)
        try:
            import fitz  # PyMuPDF

            doc = fitz.open(str(pdf_path))
            try:
                if page > doc.page_count:
                    raise HTTPException(status_code=400, detail=f"页码超出范围：最大 {doc.page_count}")
                p = doc.load_page(page - 1)
                pix = p.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
                png = pix.tobytes("png")
            finally:
                doc.close()
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"渲染 PDF 失败：{type(e).__name__}: {e}") from e

        return Response(content=png, media_type="image/png")

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @app.get("/batch/tests", response_model=BatchTestsListResponse)
    def list_batch_tests() -> BatchTestsListResponse:
        items = [_batch_item_model(x) for x in batch_store.list_items()]
        return BatchTestsListResponse(items=items)

    @app.post("/batch/tests", response_model=BatchTestResponse)
    def create_batch_test(req: CreateBatchTestRequest) -> BatchTestResponse:
        try:
            item = batch_store.create(question=req.question, reference_answer=req.reference_answer)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return BatchTestResponse(item=_batch_item_model(item))

    @app.post("/batch/tests/import", response_model=ImportBatchTestsResponse)
    def import_batch_tests(req: ImportBatchTestsRequest) -> ImportBatchTestsResponse:
        try:
            entries = parse_batch_import_text(req.text, fmt=req.format)
            created = batch_store.create_many(entries)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        items = [_batch_item_model(x) for x in created]
        return ImportBatchTestsResponse(imported=len(items), items=items)

    @app.put("/batch/tests/{item_id}", response_model=BatchTestResponse)
    def update_batch_test(item_id: str, req: UpdateBatchTestRequest) -> BatchTestResponse:
        try:
            item = batch_store.update(
                item_id,
                question=req.question,
                reference_answer=req.reference_answer,
            )
        except KeyError as e:
            raise HTTPException(status_code=404, detail="测试用例不存在") from e
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return BatchTestResponse(item=_batch_item_model(item))

    @app.delete("/batch/tests/{item_id}", response_model=BatchTestResponse)
    def delete_batch_test(item_id: str) -> BatchTestResponse:
        try:
            item = batch_store.delete(item_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail="测试用例不存在") from e
        return BatchTestResponse(item=_batch_item_model(item))

    @app.post("/batch/tests/{item_id}/run", response_model=BatchTestRunResponse)
    def run_batch_test(item_id: str) -> BatchTestRunResponse:
        item = batch_store.get(item_id)
        if not item:
            raise HTTPException(status_code=404, detail="测试用例不存在")
        question = str(item.get("question") or "").strip()
        reference = str(item.get("reference_answer") or "").strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 为空")

        batch_store.update(item_id, status="running", last_error="", model_answer="")
        t_total0 = time.perf_counter()
        route_ms = 0.0
        agents_ms = 0.0
        need_clarification = False
        clarification_question = ""
        model_answer = ""
        last_agent_id = ""
        knowledge_source = ""
        accuracy_percent = None
        accuracy_reason = ""
        status = "error"
        last_error = ""

        try:
            agents = store.get_all()
            t_route0 = time.perf_counter()
            route_result = route_question(
                question=question,
                agents=agents,
                llm=llm,
                router_model=settings.router_model,
            )
            route_ms = (time.perf_counter() - t_route0) * 1000.0
            need_clarification = route_result.need_clarification
            clarification_question = route_result.clarification_question or ""

            if need_clarification:
                model_answer = clarification_question or "路由需澄清，未生成回答"
                status = "done"
            else:
                answers, merged_answer, _illustrations, timings = run_agents(
                    question=question,
                    route_result=route_result,
                    agents=agents,
                    llm=llm,
                    settings=settings,
                )
                agents_ms = timings.agents_ms if timings else 0.0
                if route_result.target_agents:
                    last_agent_id = route_result.target_agents[0].agent_id
                if answers:
                    knowledge_source = answers[0].knowledge_source or ""
                if not knowledge_source and last_agent_id:
                    knowledge_source = f"files/agent_{last_agent_id}/knowledge.md"
                model_answer = (merged_answer or "").strip()
                if not model_answer and answers:
                    model_answer = (answers[0].answer or "").strip()
                if not model_answer:
                    model_answer = "（空回答）"

                accuracy_percent, accuracy_reason = evaluate_answer_accuracy(
                    question=question,
                    reference_answer=reference,
                    model_answer=model_answer,
                    llm=llm,
                    model=settings.answer_model,
                )
                status = "done"
        except LLMError as e:
            last_error = str(e)
            status = "error"
        except Exception as e:  # noqa: BLE001
            last_error = f"{type(e).__name__}: {e}"
            status = "error"

        total_ms = (time.perf_counter() - t_total0) * 1000.0
        try:
            updated = batch_store.update(
                item_id,
                model_answer=model_answer,
                accuracy_percent=accuracy_percent,
                accuracy_reason=accuracy_reason,
                status=status,
                last_agent_id=last_agent_id,
                knowledge_source=knowledge_source,
                last_error=last_error,
            )
        except KeyError as e:
            raise HTTPException(status_code=404, detail="测试用例不存在") from e

        return BatchTestRunResponse(
            item=_batch_item_model(updated),
            route_ms=route_ms,
            agents_ms=agents_ms,
            total_ms=total_ms,
            need_clarification=need_clarification,
            clarification_question=clarification_question,
        )

    @app.get("/agents", response_model=AgentsResponse)
    def list_agents() -> AgentsResponse:
        # agents.json 本身不包含 API_KEY；这里也不暴露 settings
        return AgentsResponse(agents=store.get_all())

    @app.post("/agents", response_model=AgentResponse)
    def create_agent(req: CreateAgentRequest) -> AgentResponse:
        agent_id = req.agent_id.strip()
        name = req.name.strip()
        if not agent_id or not name:
            raise HTTPException(status_code=400, detail="agent_id/name 不能为空")
        try:
            cfg = store.create_agent(agent_id=agent_id, name=name)
            _ensure_agent_folder(settings, agent_id, create_knowledge=False)
            return AgentResponse(agent_id=agent_id, agent=cfg)
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e

    @app.post("/agents/auto", response_model=AutoCreateAgentResponse)
    def create_agent_auto() -> AutoCreateAgentResponse:
        agent_id = store.next_available_agent_id()
        name = f"agent_{agent_id}"
        cfg = store.create_agent(agent_id=agent_id, name=name)
        _ensure_agent_folder(settings, agent_id, create_knowledge=True)
        return AutoCreateAgentResponse(agent_id=agent_id, name=name, agent=cfg)

    @app.delete("/agents/{agent_id}", response_model=AgentResponse)
    def delete_agent(agent_id: str) -> AgentResponse:
        cfg = store.get(agent_id)
        if not cfg:
            raise HTTPException(status_code=404, detail="agent_id 不存在")
        try:
            deleted = store.delete_agent(agent_id=agent_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        agent_dir = (settings.files_root / _agent_folder_name(agent_id)).resolve()
        if agent_dir.exists():
            shutil.rmtree(agent_dir)
        return AgentResponse(agent_id=agent_id, agent=deleted)

    @app.post("/agents/{agent_id}/rename", response_model=AgentResponse)
    def rename_agent(agent_id: str, req: RenameAgentRequest) -> AgentResponse:
        new_id = req.new_agent_id.strip()
        if not new_id:
            raise HTTPException(status_code=400, detail="new_agent_id 不能为空")
        if not store.get(agent_id):
            raise HTTPException(status_code=404, detail="agent_id 不存在")
        if store.get(new_id):
            raise HTTPException(status_code=409, detail="new_agent_id 已存在")
        old_dir = (settings.files_root / _agent_folder_name(agent_id)).resolve()
        new_dir = (settings.files_root / _agent_folder_name(new_id)).resolve()
        if new_dir.exists():
            raise HTTPException(status_code=409, detail="目标 agent 文件夹已存在")
        try:
            cfg = store.rename_agent(agent_id=agent_id, new_agent_id=new_id)
        except (KeyError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        if old_dir.exists():
            old_dir.rename(new_dir)
        else:
            _ensure_agent_folder(settings, new_id, create_knowledge=False)
        return AgentResponse(agent_id=new_id, agent=cfg)

    @app.get("/agents/{agent_id}", response_model=AgentResponse)
    def get_agent(agent_id: str) -> AgentResponse:
        cfg = store.get(agent_id)
        if not cfg:
            raise HTTPException(status_code=404, detail="agent_id 不存在")
        return AgentResponse(agent_id=agent_id, agent=cfg)

    @app.post("/agents/{agent_id}/files/register", response_model=AgentResponse)
    def register_files(agent_id: str, req: RegisterFilesRequest) -> AgentResponse:
        files = [f.strip() for f in (req.files or []) if isinstance(f, str) and f.strip()]
        if not files:
            raise HTTPException(status_code=400, detail="files 不能为空")
        try:
            cfg = store.register_files(agent_id=agent_id, files=files)
            return AgentResponse(agent_id=agent_id, agent=cfg)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

    @app.post("/agents/{agent_id}/files/upload", response_model=AgentResponse)
    def upload_file(agent_id: str, file: UploadFile = File(...)) -> AgentResponse:
        cfg = store.get(agent_id)
        if not cfg:
            raise HTTPException(status_code=404, detail="agent_id 不存在")

        filename = _sanitize_filename(file.filename or "")
        ext = Path(filename).suffix.lower()
        allowed = {".pdf", ".docx", ".xlsx", ".md", ".txt", ".json", ".csv"}
        if ext not in allowed:
            raise HTTPException(status_code=400, detail=f"不支持的文件类型：{ext}")

        agent_dir = (settings.files_root / _agent_folder_name(agent_id)).resolve()
        agent_dir.mkdir(parents=True, exist_ok=True)
        dest = (agent_dir / filename).resolve()

        try:
            content = file.file.read()
            dest.write_bytes(content)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"保存上传文件失败：{type(e).__name__}: {e}") from e

        # Store as relative path if possible
        try:
            rel = dest.relative_to(settings.data_root).as_posix()
        except Exception:
            rel = str(dest)

        cfg = store.register_files(agent_id=agent_id, files=[rel])
        return AgentResponse(agent_id=agent_id, agent=cfg)

    @app.put("/agents/{agent_id}/knowledge", response_model=AgentResponse)
    def update_agent_knowledge(agent_id: str, req: UpdateAgentKnowledgeRequest) -> AgentResponse:
        knowledge = req.knowledge.strip()
        if not knowledge:
            raise HTTPException(status_code=400, detail="knowledge 不能为空")
        try:
            cfg = store.set_knowledge(agent_id=agent_id, knowledge=knowledge)
            return AgentResponse(agent_id=agent_id, agent=cfg)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

    @app.put("/agents/{agent_id}/instructions", response_model=AgentResponse)
    def update_agent_instructions(agent_id: str, req: UpdateAgentInstructionsRequest) -> AgentResponse:
        try:
            cfg = store.set_answer_instructions(
                agent_id=agent_id,
                answer_instructions=(req.answer_instructions or "").strip(),
            )
            return AgentResponse(agent_id=agent_id, agent=cfg)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

    @app.put("/agents/{agent_id}/prompt", response_model=AgentResponse)
    def update_agent_prompt(agent_id: str, req: UpdateAgentPromptRequest) -> AgentResponse:
        """Deprecated: 写入 knowledge 字段。"""
        knowledge = req.answer_prompt.strip()
        if not knowledge:
            raise HTTPException(status_code=400, detail="knowledge 不能为空")
        try:
            cfg = store.set_knowledge(agent_id=agent_id, knowledge=knowledge)
            return AgentResponse(agent_id=agent_id, agent=cfg)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e

    @app.post("/agents/{agent_id}/initialize", response_model=InitializeResponse)
    def initialize(agent_id: str) -> InitializeResponse:
        cfg = store.get(agent_id)
        if not cfg:
            raise HTTPException(status_code=404, detail="agent_id 不存在")
        files_dir = agent_files_dir(agent_id)
        configured_knowledge = str(cfg.get("knowledge", "") or cfg.get("answer_prompt", "") or "")

        knowledge_text, knowledge_source, _ = resolve_agent_knowledge(
            project_root=settings.data_root,
            agent_id=agent_id,
            configured_knowledge=configured_knowledge,
            max_chars=settings.max_file_chars,
            require_file_knowledge=True,
        )
        if not knowledge_text:
            store.reset_agent_to_created(agent_id=agent_id)
            raise HTTPException(
                status_code=400,
                detail="知识内容为空，已同步清空 agents.json 中该 agent 的缓存。请在 files/agent_{id}/ 下放置任意 .md 或 .pdf 后重新初始化。".format(
                    id=agent_id
                ),
            )

        try:
            store.set_knowledge(agent_id=agent_id, knowledge=knowledge_text)
            route_questions, file_summaries = generate_route_questions_and_summaries(
                agent_id=agent_id,
                agent_name=str(cfg.get("name", agent_id)),
                knowledge=knowledge_text,
                knowledge_source=knowledge_source,
                llm=llm,
                init_model=settings.init_model,
                min_route_questions=settings.min_route_questions,
                max_route_questions=settings.max_route_questions,
            )
            updated = store.update_initialized(
                agent_id=agent_id,
                files=[knowledge_source],
                route_questions=route_questions,
                file_summaries=file_summaries,
            )
            return InitializeResponse(
                agent_id=agent_id,
                status=updated.get("status", "initialized"),
                route_questions_count=len(route_questions),
                last_initialized_at=updated.get("last_initialized_at", ""),
            )
        except LLMError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

    @app.post("/agents/{agent_id}/refresh", response_model=InitializeResponse)
    def refresh(agent_id: str) -> InitializeResponse:
        return initialize(agent_id)

    @app.post("/agents/sync-from-files", response_model=SyncAgentsResponse)
    def sync_agents_from_files() -> SyncAgentsResponse:
        """Align every agent in agents.json with files/agent_{id}/ on disk."""
        results = sync_all_agents_from_files(
            store=store,
            project_root=settings.data_root,
            max_chars=settings.max_file_chars,
        )
        return SyncAgentsResponse(results=results)

    @app.post("/agents/{agent_id}/sync-from-files", response_model=SyncAgentsResponse)
    def sync_single_agent_from_files(agent_id: str) -> SyncAgentsResponse:
        if not store.get(agent_id):
            raise HTTPException(status_code=404, detail="agent_id 不存在")
        result = sync_agent_from_files(
            store=store,
            project_root=settings.data_root,
            agent_id=agent_id,
            max_chars=settings.max_file_chars,
        )
        return SyncAgentsResponse(results={agent_id: result})

    @app.post("/ask", response_model=AskResponse)
    def ask(req: AskRequest) -> AskResponse:
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")

        try:
            t_total0 = time.perf_counter()
            agents = store.get_all()
            t_route0 = time.perf_counter()
            route_result = route_question(
                question=question,
                agents=agents,
                llm=llm,
                router_model=settings.router_model,
            )
            route_ms = (time.perf_counter() - t_route0) * 1000.0

            if route_result.need_clarification:
                total_ms = (time.perf_counter() - t_total0) * 1000.0
                return AskResponse(
                    question=question,
                    target_agents=[],
                    need_clarification=True,
                    clarification_question=route_result.clarification_question,
                    answers=[],
                    merged_answer="",
                    merged_illustrations=[],
                    timings={"total_ms": total_ms, "route_ms": route_ms},
                )

            answers, merged_answer, merged_illustrations, timings = run_agents(
                question=question,
                route_result=route_result,
                agents=agents,
                llm=llm,
                settings=settings,
            )
            timings.route_ms = route_ms
            timings.total_ms = (time.perf_counter() - t_total0) * 1000.0

            return AskResponse(
                question=question,
                target_agents=route_result.target_agents,
                need_clarification=False,
                clarification_question="",
                answers=answers,
                merged_answer=merged_answer,
                merged_illustrations=merged_illustrations,
                timings=timings,
            )
        except LLMError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"服务内部错误：{type(e).__name__}: {e}") from e

    @app.post("/ask/stream")
    def ask_stream(req: AskRequest) -> StreamingResponse:
        question = req.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="question 不能为空")

        def generate():
            try:
                t_total0 = time.perf_counter()
                agents = store.get_all()
                yield _sse_log("info", f"开始处理提问（{len(question)} 字）")
                t_route0 = time.perf_counter()
                route_parts: List[str] = []
                route_first_token_ms: float | None = None
                eligible_agents = get_eligible_agents(agents)
                yield _sse_log(
                    "info",
                    f"可路由 agent {len(eligible_agents)} 个",
                    {"agent_ids": list(eligible_agents.keys())},
                )
                if not eligible_agents:
                    route_result = no_agents_router_result()
                    route_ms = (time.perf_counter() - t_route0) * 1000.0
                    yield _sse_log("warn", "没有可路由 agent，跳过路由模型")
                else:
                    yield _sse_log("route", f"调用路由模型 {settings.router_model}")
                    route_messages = build_route_messages(
                        question=question,
                        eligible_agents=eligible_agents,
                    )
                    yield _sse_log(
                        "info",
                        "路由 prompt 已构建",
                        {"messages": len(route_messages), "question": question},
                    )
                    for chunk in llm.chat_stream(
                        model=settings.router_model,
                        messages=route_messages,
                    ):
                        if route_first_token_ms is None:
                            route_first_token_ms = (time.perf_counter() - t_total0) * 1000.0
                        route_parts.append(chunk)
                        route_delta_payload: Dict[str, Any] = {"content": chunk}
                        if len(route_parts) == 1 and route_first_token_ms is not None:
                            route_delta_payload["route_first_token_ms"] = route_first_token_ms
                            yield _sse_log("route", f"路由首字 · {route_first_token_ms:.0f} ms")
                        yield _sse("route_delta", route_delta_payload)
                    route_ms = (time.perf_counter() - t_route0) * 1000.0
                    route_result = parse_route_raw(raw="".join(route_parts), eligible_agents=eligible_agents)
                    yield _sse_log(
                        "route",
                        f"路由 JSON 解析完成 · {route_ms:.0f} ms · raw {len(''.join(route_parts))} 字",
                    )
                    if route_result.need_clarification:
                        yield _sse_log(
                            "warn",
                            "路由需澄清",
                            route_result.clarification_question or "",
                        )
                    else:
                        for t in route_result.target_agents:
                            yield _sse_log(
                                "route",
                                f"命中 agent {t.agent_id} · confidence={t.confidence}",
                                t.model_dump(),
                            )

                yield _sse(
                    "route",
                    {
                        "question": question,
                        "target_agents": [t.model_dump() for t in route_result.target_agents],
                        "need_clarification": route_result.need_clarification,
                        "clarification_question": route_result.clarification_question,
                        "route_ms": route_ms,
                        "route_first_token_ms": route_first_token_ms or 0.0,
                        "route_raw": "".join(route_parts),
                    },
                )

                if route_result.need_clarification:
                    total_ms = (time.perf_counter() - t_total0) * 1000.0
                    yield _sse(
                        "done",
                        AskResponse(
                            question=question,
                            target_agents=[],
                            need_clarification=True,
                            clarification_question=route_result.clarification_question,
                            answers=[],
                            merged_answer="",
                            merged_illustrations=[],
                            timings={"total_ms": total_ms, "route_ms": route_ms},
                        ).model_dump(),
                    )
                    return

                if not route_result.target_agents:
                    total_ms = (time.perf_counter() - t_total0) * 1000.0
                    yield _sse(
                        "done",
                        AskResponse(
                            question=question,
                            target_agents=[],
                            need_clarification=True,
                            clarification_question="未选中任何 agent。",
                            answers=[],
                            merged_answer="",
                            merged_illustrations=[],
                            timings={"total_ms": total_ms, "route_ms": route_ms},
                        ).model_dump(),
                    )
                    return

                target = route_result.target_agents[0]

                prep = summarize_agent_prepare(
                    target=target,
                    question=question,
                    cfg=agents[target.agent_id],
                    settings=settings,
                )
                yield _sse_log("info", f"Agent 准备完成 · {target.agent_id}", prep)
                if not prep.get("knowledge_chars"):
                    yield _sse_log("warn", f"agent {target.agent_id} 无知识内容，将返回空知识提示")

                t_agents0 = time.perf_counter()
                t_llm0 = time.perf_counter()
                yield _sse_log("info", f"开始回答模型 {settings.answer_model}（流式）")
                parts: List[str] = []
                first_token_ms: float | None = None
                for chunk in stream_single_agent_answer(
                    target=target,
                    question=question,
                    cfg=agents[target.agent_id],
                    llm=llm,
                    settings=settings,
                ):
                    if first_token_ms is None:
                        first_token_ms = (time.perf_counter() - t_total0) * 1000.0
                    parts.append(chunk)
                    delta_payload: Dict[str, Any] = {"content": chunk}
                    if len(parts) == 1 and first_token_ms is not None:
                        delta_payload["first_token_ms"] = first_token_ms
                        yield _sse_log("ok", f"回答首字 · {first_token_ms:.0f} ms")
                    yield _sse("delta", delta_payload)

                llm_answer_ms = (time.perf_counter() - t_llm0) * 1000.0
                answer_text = "".join(parts)
                yield _sse_log(
                    "ok",
                    f"回答流式结束 · {len(answer_text)} 字 · LLM {llm_answer_ms:.0f} ms",
                )
                yield _sse_log("info", "提取引用与 finalize…")
                per_agent = finalize_streamed_agent_answer(
                    target=target,
                    question=question,
                    cfg=agents[target.agent_id],
                    settings=settings,
                    answer_text=answer_text,
                    agents_ms=0.0,
                    llm_answer_ms=llm_answer_ms,
                )
                agents_ms = (time.perf_counter() - t_agents0) * 1000.0
                if per_agent.timings:
                    per_agent.timings.total_ms = agents_ms
                illustrations = _citations_to_illustrations(per_agent.citations)
                yield _sse_log(
                    "ok",
                    f"finalize 完成 · 引用 {len(per_agent.citations)} 条 · citations {per_agent.timings.citations_ms if per_agent.timings else 0:.0f} ms",
                    {
                        "used_files": per_agent.used_files,
                        "citations": [c.model_dump() for c in per_agent.citations],
                        "timings": per_agent.timings.model_dump() if per_agent.timings else {},
                    },
                )
                total_ms = (time.perf_counter() - t_total0) * 1000.0
                yield _sse_log(
                    "ok",
                    f"全流程结束 · 总 {total_ms:.0f} ms · 路由 {route_ms:.0f} ms · Agent {agents_ms:.0f} ms",
                )
                yield _sse(
                    "done",
                    AskResponse(
                        question=question,
                        target_agents=route_result.target_agents,
                        need_clarification=False,
                        clarification_question="",
                        answers=[per_agent],
                        merged_answer=per_agent.answer,
                        merged_illustrations=illustrations,
                        timings={
                            "total_ms": total_ms,
                            "route_ms": route_ms,
                            "route_first_token_ms": route_first_token_ms or 0.0,
                            "first_token_ms": first_token_ms or 0.0,
                            "agents_ms": agents_ms,
                            "merge_ms": 0.0,
                        },
                    ).model_dump(),
                )
            except LLMError as e:
                yield _sse("error", {"detail": str(e)})
            except Exception as e:  # noqa: BLE001
                yield _sse("error", {"detail": f"服务内部错误：{type(e).__name__}: {e}"})

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


app = create_app()

