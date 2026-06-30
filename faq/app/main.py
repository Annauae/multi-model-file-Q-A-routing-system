from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import ensure_runtime_dirs, settings
from .database import db_exists
from .evaluator import get_eval_run, latest_eval_runs, start_eval_run
from .indexer import rebuild_index
from .retriever import Retriever, index_status
from .runtime_config import load_runtime_config, update_runtime_config


ensure_runtime_dirs(settings)

app = FastAPI(title="FAQ Traditional RAG", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_static_cache(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/web/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response

if settings.assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(settings.assets_dir)), name="assets")

WEB_DIR = settings.root_dir / "web"
if WEB_DIR.is_dir():
    app.mount("/web", StaticFiles(directory=str(WEB_DIR)), name="web")


class QueryRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int | None = Field(default=None, ge=1, le=50)


class ChatRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_n: int | None = Field(default=None, ge=1, le=10)
    use_llm_answer: bool | None = None


class EvalRunRequest(BaseModel):
    size: Literal[10, 50, 100] = 10
    mode: Literal["question", "indexed_variant", "holdout_variant", "mixed"] = "mixed"
    top_k: int = Field(default=5, ge=1, le=20)
    use_llm_answer: bool = False


class TemplateModel(BaseModel):
    id: str
    name: str = ""
    content: str = ""


class ConfigRequest(BaseModel):
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_k: int | None = Field(default=None, ge=1, le=50)
    top_n: int | None = Field(default=None, ge=1, le=10)
    answer_mode: Literal["direct", "generated"] | None = None
    use_rerank: bool | None = None
    min_confidence_score: float | None = Field(default=None, ge=0.0, le=1.0)
    active_template_id: str | None = None
    templates: list[TemplateModel] | None = None


def _retriever() -> Retriever:
    return Retriever(settings, runtime=load_runtime_config(settings))


@app.get("/")
def index():
    index_file = WEB_DIR / "index.html"
    if index_file.is_file():
        return FileResponse(
            index_file,
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
    return {"message": "FAQ Traditional RAG"}


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "db_exists": db_exists(settings),
        "index": index_status(settings),
        "python": sys.version,
    }


@app.get("/api/config")
def get_config():
    return load_runtime_config(settings).to_dict()


@app.put("/api/config")
def put_config(req: ConfigRequest):
    patch: dict[str, Any] = req.model_dump(exclude_none=True)
    if req.templates is not None:
        patch["templates"] = [t.model_dump() for t in req.templates]
    rc = update_runtime_config(patch, settings)
    return rc.to_dict()


@app.post("/api/index/rebuild")
def api_rebuild_index():
    meta = rebuild_index(settings)
    return {"ok": True, "meta": meta}


@app.get("/api/search")
def api_search_get(q: str = Query(..., min_length=1), top_k: int | None = Query(None, ge=1, le=50)):
    _ensure_ready()
    results, timing = _retriever().search(q, top_k=top_k)
    return {"query": q, "results": results, "timing": timing}


@app.post("/api/search")
def api_search_post(req: QueryRequest):
    _ensure_ready()
    results, timing = _retriever().search(req.query, top_k=req.top_k)
    return {"query": req.query, "results": results, "timing": timing}


@app.post("/api/chat")
def api_chat(req: ChatRequest):
    _ensure_ready()
    return {
        "query": req.query,
        **_retriever().chat(req.query, top_n=req.top_n, use_llm_answer=req.use_llm_answer),
    }


@app.post("/api/eval/run")
def api_eval_run(req: EvalRunRequest):
    _ensure_ready()
    run_id = start_eval_run(
        size=req.size,
        mode=req.mode,
        top_k=req.top_k,
        use_llm_answer=req.use_llm_answer,
        cfg=settings,
    )
    return {"run_id": run_id, "status": "queued"}


@app.get("/api/eval/runs")
def api_eval_runs(limit: int = Query(10, ge=1, le=50)):
    _ensure_ready()
    return {"runs": latest_eval_runs(limit, settings)}


@app.get("/api/eval/runs/{run_id}")
def api_eval_run_detail(run_id: str):
    _ensure_ready()
    run = get_eval_run(run_id, settings)
    if run is None:
        raise HTTPException(status_code=404, detail="eval run not found")
    return run


def _ensure_ready() -> None:
    status = index_status(settings)
    if not status.get("ready"):
        raise HTTPException(status_code=409, detail="索引不存在，请先运行 scripts/build_index.py --rebuild")
