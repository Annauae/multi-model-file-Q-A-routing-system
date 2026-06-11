# 多模型文件问答调度系统

[English](README.en.md)

## 1. 项目介绍

这是一个基于 **FastAPI** 的多模型文件问答调度系统，适用于产品说明书、技术文档等场景：将大文档拆成多个专题 **agent**，用语义路由选中对应章节，再基于原文（含插图）生成回答与引用。

**核心特点：**

- **不使用向量库 / RAG**，不做文件预入库；每次问答实时读取本地知识文件。
- **三模型分工**：
  - `ROUTER_MODEL` — 根据各 agent 的 `route_questions` 做语义路由
  - `INIT_MODEL` — 初始化时生成路由问题与摘要
  - `ANSWER_MODEL` — 基于知识内容回答
- **无规则路由**：不使用关键词匹配或 if/else 规则，完全依赖 LLM 语义判断。
- **单 agent 调度**：每次问答最多选中 **1 个** agent。

**工作流程：**

```
创建 agent → 准备 knowledge.md → initialize 生成 route_questions
     ↓
用户提问 → 路由模型选 agent → 读取知识 → 回答模型生成答案 + 引用
     ↓（无法匹配）
返回 need_clarification=true（不调用任何 agent）
```

## 2. 安装依赖

在 `model_router/` 目录下执行：

```bash
pip install fastapi uvicorn python-dotenv openai pydantic pymupdf python-docx openpyxl pytest httpx
```

## 3. 配置 .env

复制示例配置并填写：

```bash
# Windows
copy .env.example .env

# Linux / macOS
cp .env.example .env
```

主要环境变量（完整列表见 `.env.example`）：

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

说明：

- 使用 **OpenAI 兼容 API**（`openai` SDK 的 `chat.completions.create`）。
- 若网关要求 `messages[].content` 为分段结构（如 `[{"type":"text","text":"..."}]`），设置 `USE_CONTENT_PARTS=1`。
- 若网关使用 `max_completion_tokens` 而非 `max_tokens`，设置 `USE_MAX_COMPLETION_TOKENS=1`。
- 若回答阶段需将 `knowledge.md` 中的插图一并送入模型，设置 `ANSWER_WITH_IMAGES=1`（需 vision 模型）。
- 测试时可设置 `MOCK_LLM=1`，无需真实上游模型。

## 4. 启动

在 `model_router/` 目录下：

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

或在仓库根目录：

```powershell
.\start-server.ps1
```

- 健康检查：`GET /health`
- Web 控制台：`http://127.0.0.1:8000/`
  - **单问题测试** — 提问、查看路由/回答/流式日志
  - **管理** — agent 与文件管理
  - **批量测试** — 导入用例、运行并评估准确率

## 5. API 一览

### 问答

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/ask` | 同步问答 |
| POST | `/ask/stream` | SSE 流式问答（路由 + 回答逐字输出） |

### Agent 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/agents` | 列出全部 agent |
| POST | `/agents` | 创建 agent |
| POST | `/agents/auto` | 自动分配 ID 并创建 |
| GET | `/agents/{agent_id}` | 查看单个 agent |
| DELETE | `/agents/{agent_id}` | 删除 agent 及其文件目录 |
| POST | `/agents/{agent_id}/rename` | 重命名 agent |
| POST | `/agents/{agent_id}/initialize` | 读取知识并生成 `route_questions` |
| POST | `/agents/{agent_id}/refresh` | 同 initialize |
| PUT | `/agents/{agent_id}/knowledge` | 更新知识文本 |
| PUT | `/agents/{agent_id}/instructions` | 更新补充回答要求 |
| POST | `/agents/{agent_id}/files/register` | 注册本地文件路径 |
| POST | `/agents/{agent_id}/files/upload` | 上传文件 |
| POST | `/agents/sync-from-files` | 批量与磁盘文件同步 |
| POST | `/agents/{agent_id}/sync-from-files` | 单个 agent 同步 |
| GET | `/agents/files` | 列出所有 agent 的知识文件 |
| GET | `/agents/{agent_id}/preview-context` | 预览回答阶段的 system 消息 |

### 文件与预览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/files/tree` | 文件树 |
| GET/PUT | `/files/raw` | 读写 `.md` / `.txt` |
| POST/DELETE | `/files` | 创建 / 删除文件 |
| POST | `/files/rename` | 重命名 |
| GET | `/preview-text` | 预览文件提取文本 |
| GET | `/preview` | PDF 指定页渲染为 PNG |
| GET | `/preview-image` | 静态图片预览 |
| GET | `/preview-media` | 视频预览 |
| GET | `/preview-asset` | 解析 MD 内相对资源引用 |

### 批量测试

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/batch/tests` | 列出测试用例 |
| POST | `/batch/tests` | 创建用例 |
| POST | `/batch/tests/import` | 批量导入（JSON / Markdown） |
| PUT/DELETE | `/batch/tests/{item_id}` | 更新 / 删除 |
| POST | `/batch/tests/{item_id}/run` | 运行单条并评估准确率 |

## 6. 新增 agent

推荐通过 API 操作（无需手工编辑 `agents.json`）：

**1) 创建 agent**

`POST /agents`

```json
{
  "agent_id": "your_agent_id",
  "name": "你的助手名称"
}
```

或使用 `POST /agents/auto` 自动分配数字 ID。

**2) 准备知识文件**

每个 agent 对应目录 `files/agent_{agent_id}/`，推荐放置：

- `knowledge.md` — 主知识文件（Markdown，可引用 `assets/` 下图片）
- 或 `.pdf`、`.docx`、`.xlsx` 等（见下文支持类型）

**3) 初始化**

`POST /agents/{agent_id}/initialize`

系统会读取知识内容，调用 `INIT_MODEL` 生成：

- `route_questions` — 50–100 条典型用户问题（**路由的主要依据**）
- `file_summaries` — 知识摘要

写入 `config/agents.json`，状态变为 `initialized`。

**路由规则：**

- `/ask` 只会调度 `status=initialized` 且 `route_questions` 非空的 agent。
- 路由模型将用户问题与各 agent 的 `route_questions` 做语义对照，选出最匹配的 **1 个** agent。
- 无法匹配时返回 `need_clarification=true`，**不会调用任何 agent**。

## 7. 知识文件

### 推荐工作流

1. 在 `files/agent_{agent_id}/` 下放置 `knowledge.md`（及 `assets/` 插图）
2. 调用 `/agents/{agent_id}/initialize`
3. `/ask` 时实时读取知识，构建带行号的 system prompt，并提取引用

### 添加文件的两种方式

**方式 A：注册本地路径**（不搬运文件）

`POST /agents/{agent_id}/files/register`

```json
{
  "files": [
    "files/agent_1/knowledge.md"
  ]
}
```

**方式 B：上传文件**

`POST /agents/{agent_id}/files/upload`（multipart/form-data，字段名 `file`）

路径支持相对 `model_router/` 或绝对路径（如 Windows 的 `D:/...`）。

### 支持的文件类型

| 类型 | 扩展名 |
|------|--------|
| 文本 | `.txt`、`.md`、`.json`、`.csv` |
| 文档 | `.pdf`（PyMuPDF）、`.docx`（python-docx）、`.xlsx`（openpyxl） |

目录扫描默认 **不递归**（仅第一层）。内容超过 `MAX_FILE_CHARS` 时会截断并提示。

### 回答与引用

- 知识内容会附加行号（`L1 | ...`），便于模型输出 `【引用】` 定位。
- 前端可展示 PDF 页缩略图、Markdown 插图及行号引用。
- 找不到依据时，模型应回答：**当前知识库中未找到相关信息**（不可编造）。

## 8. 辅助脚本

`scripts/` 目录提供文档拆分、批量初始化等工具，例如：

| 脚本 | 用途 |
|------|------|
| `split_whole_to_agents.py` | 将 `whole.md` 拆分为多个 agent 的 `knowledge.md` |
| `batch_initialize_agents.py` | 批量初始化 agent |
| `sync_agents_from_files.py` | 从磁盘同步 agent 配置 |
| `convert_knowledge_to_faq.py` | 知识转 FAQ 格式 |
| `refresh_agents.py` | 批量 refresh |

## 9. 测试

在 `model_router/` 目录下：

```bash
pytest -q
```

测试默认通过 `MOCK_LLM=1` 模拟 LLM 响应，不依赖真实 API。

## 10. 注意事项

- 每次问答都会读取知识并发送给模型，**文件越大，token 消耗越多、响应越慢**。
- 建议按主题拆分 agent，使 `route_questions` 覆盖范围明确，减少误路由。
- `agents.json` 与 `config/batch_tests.json` 为本地持久化配置，部署时注意备份。
- 生产环境请妥善保管 `.env` 中的 `API_KEY`，勿提交到版本库。
