# Multi-Model File Q&A Router

[中文](README.md)

## 1. Overview

A **FastAPI**-based multi-model file Q&A routing system for product manuals, technical docs, and similar content. Large documents are split into topic **agents**; a router model picks the best agent per question, then an answer model responds from source material (including illustrations) with citations.

**Key characteristics:**

- **No vector DB / RAG** and no pre-indexing; knowledge files are read on every request.
- **Three-model pipeline**:
  - `ROUTER_MODEL` — semantic routing via each agent's `route_questions`
  - `INIT_MODEL` — generates routing questions and summaries at initialization
  - `ANSWER_MODEL` — answers from knowledge content only
- **No rule-based routing** — no keyword matching or if/else rules; routing is LLM-driven.
- **Single-agent dispatch** — at most **one** agent is selected per question.

**Flow:**

```
Create agent → Prepare knowledge.md → initialize (route_questions)
     ↓
User question → Router picks agent → Load knowledge → Answer + citations
     ↓ (no match)
Return need_clarification=true (no agent invoked)
```

## 2. Install Dependencies

From the `model_router/` directory:

```bash
pip install fastapi uvicorn python-dotenv openai pydantic pymupdf python-docx openpyxl pytest httpx
```

## 3. Configure `.env`

Copy the example and fill in your values:

```bash
# Windows
copy .env.example .env

# Linux / macOS
cp .env.example .env
```

Main variables (see `.env.example` for the full list):

```env
API_BASE_URL=https://api.openai.com/v1
API_KEY=your_api_key_here

ROUTER_MODEL=gpt-4.1-mini
INIT_MODEL=gpt-4.1-mini
ANSWER_MODEL=gpt-4.1

MAX_FILE_CHARS=120000
MAX_TOKENS=4096
ANSWER_MAX_TOKENS=512
MAX_ANSWER_CHARS=0

USE_CONTENT_PARTS=0
USE_MAX_COMPLETION_TOKENS=0

ANSWER_WITH_IMAGES=1
MAX_ANSWER_IMAGES=0

MIN_ROUTE_QUESTIONS=50
MAX_ROUTE_QUESTIONS=100

MOCK_LLM=0
```

Notes:

- Uses an **OpenAI-compatible API** via the `openai` SDK (`chat.completions.create`).
- Set `USE_CONTENT_PARTS=1` if your gateway expects segmented `messages[].content` (e.g. `[{"type":"text","text":"..."}]`).
- Set `USE_MAX_COMPLETION_TOKENS=1` if your gateway uses `max_completion_tokens` instead of `max_tokens`.
- Set `ANSWER_WITH_IMAGES=1` to include illustrations from `knowledge.md` in the answer prompt (requires a vision-capable model).
- Set `MOCK_LLM=1` for tests without a real upstream model.

## 4. Run the Server

From `model_router/`:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Or from the repo root:

```powershell
.\start-server.ps1
```

- Health check: `GET /health`
- Web console: `http://127.0.0.1:8000/`
  - **Single question** — ask, view routing/answer/stream logs
  - **Manage** — agents and files
  - **Batch tests** — import cases, run, and score accuracy

## 5. API Reference

### Q&A

| Method | Path | Description |
|--------|------|-------------|
| POST | `/ask` | Synchronous Q&A |
| POST | `/ask/stream` | SSE streaming (routing + token-by-token answer) |

### Agent Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents` | List all agents |
| POST | `/agents` | Create agent |
| POST | `/agents/auto` | Auto-assign numeric ID and create |
| GET | `/agents/{agent_id}` | Get one agent |
| DELETE | `/agents/{agent_id}` | Delete agent and its file directory |
| POST | `/agents/{agent_id}/rename` | Rename agent |
| POST | `/agents/{agent_id}/initialize` | Load knowledge and generate `route_questions` |
| POST | `/agents/{agent_id}/refresh` | Same as initialize |
| PUT | `/agents/{agent_id}/knowledge` | Update knowledge text |
| PUT | `/agents/{agent_id}/instructions` | Update extra answer instructions |
| POST | `/agents/{agent_id}/files/register` | Register local file paths |
| POST | `/agents/{agent_id}/files/upload` | Upload file |
| POST | `/agents/sync-from-files` | Sync all agents from disk |
| POST | `/agents/{agent_id}/sync-from-files` | Sync one agent |
| GET | `/agents/files` | List knowledge files for all agents |
| GET | `/agents/{agent_id}/preview-context` | Preview the answer-stage system message |

### Files & Preview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/files/tree` | File tree |
| GET/PUT | `/files/raw` | Read/write `.md` / `.txt` |
| POST/DELETE | `/files` | Create / delete file |
| POST | `/files/rename` | Rename file |
| GET | `/preview-text` | Preview extracted text |
| GET | `/preview` | Render PDF page as PNG |
| GET | `/preview-image` | Static image preview |
| GET | `/preview-media` | Video preview |
| GET | `/preview-asset` | Resolve relative asset refs in Markdown |

### Batch Tests

| Method | Path | Description |
|--------|------|-------------|
| GET | `/batch/tests` | List test cases |
| POST | `/batch/tests` | Create case |
| POST | `/batch/tests/import` | Bulk import (JSON / Markdown) |
| PUT/DELETE | `/batch/tests/{item_id}` | Update / delete |
| POST | `/batch/tests/{item_id}/run` | Run one case and score accuracy |

## 6. Add an Agent

Use the API (no manual `agents.json` editing required):

**1) Create agent**

`POST /agents`

```json
{
  "agent_id": "your_agent_id",
  "name": "Your assistant name"
}
```

Or use `POST /agents/auto` for an auto-assigned numeric ID.

**2) Prepare knowledge**

Each agent uses `files/agent_{agent_id}/`. Recommended layout:

- `knowledge.md` — primary knowledge (Markdown; images under `assets/`)
- Or `.pdf`, `.docx`, `.xlsx`, etc. (see supported types below)

**3) Initialize**

`POST /agents/{agent_id}/initialize`

The system reads knowledge and calls `INIT_MODEL` to produce:

- `route_questions` — 50–100 typical user questions (**primary routing signal**)
- `file_summaries` — knowledge summaries

Results are stored in `config/agents.json` with `status=initialized`.

**Routing rules:**

- `/ask` only considers agents with `status=initialized` and non-empty `route_questions`.
- The router compares the user question to each agent's `route_questions` and picks the best **single** match.
- If no match, `need_clarification=true` is returned and **no agent runs**.

## 7. Knowledge Files

### Recommended workflow

1. Place `knowledge.md` (and `assets/` images) under `files/agent_{agent_id}/`
2. Call `/agents/{agent_id}/initialize`
3. On `/ask`, knowledge is loaded live, line-numbered for the system prompt, and citations are extracted

### Two ways to attach files

**Option A: Register local paths** (no file copy)

`POST /agents/{agent_id}/files/register`

```json
{
  "files": [
    "files/agent_1/knowledge.md"
  ]
}
```

**Option B: Upload**

`POST /agents/{agent_id}/files/upload` (multipart/form-data, field name `file`)

Paths may be relative to `model_router/` or absolute (e.g. `D:/...` on Windows).

### Supported file types

| Category | Extensions |
|----------|------------|
| Text | `.txt`, `.md`, `.json`, `.csv` |
| Documents | `.pdf` (PyMuPDF), `.docx` (python-docx), `.xlsx` (openpyxl) |

Directory scans are **non-recursive** (top level only). Content beyond `MAX_FILE_CHARS` is truncated with a notice.

### Answers & citations

- Knowledge is prefixed with line numbers (`L1 | ...`) for `【引用】`-style citations.
- The UI can show PDF page thumbnails, Markdown images, and line references.
- When evidence is missing, the model should reply: **当前知识库中未找到相关信息** (no fabrication).

## 8. Helper Scripts

The `scripts/` folder includes tools for splitting docs and batch operations, e.g.:

| Script | Purpose |
|--------|---------|
| `split_whole_to_agents.py` | Split `whole.md` into per-agent `knowledge.md` files |
| `batch_initialize_agents.py` | Batch-initialize agents |
| `sync_agents_from_files.py` | Sync agent config from disk |
| `convert_knowledge_to_faq.py` | Convert knowledge to FAQ format |
| `refresh_agents.py` | Batch refresh |

## 9. Tests

From `model_router/`:

```bash
pytest -q
```

Tests use `MOCK_LLM=1` by default and do not require a live API.

## 10. Notes

- Every question reloads knowledge into the model context — **larger files mean more tokens and slower responses**.
- Split content by topic and keep `route_questions` focused to reduce mis-routing.
- `agents.json` and `config/batch_tests.json` are local persistence; back them up when deploying.
- Keep `API_KEY` in `.env` secret; do not commit it to version control.
