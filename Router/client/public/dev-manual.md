# Router 项目开发者手册

> 本文档面向参与 Router（知识问答控制台）开发与运维的工程师。目标读者是**尚未读过代码**的新同事：按本文顺序阅读，应能独立理解系统做什么、数据存在哪、各页面调哪些 API。  
> 代码基准：`server/src/app.js`、`server/src/routes/ragRoutes.js`、`server/migrations/001_initial.sql`、`client/src/App.tsx`、`client/src/views/ManageFilesView.tsx`、`client/src/types.ts`。

### 阅读路径（建议顺序）

| 步骤 | 章节 | 你将了解到 |
|------|------|------------|
| 1 | **§1.5 必读** | 所有 UI 页面、功能与 PostgreSQL / 磁盘 / Weaviate 的对应关系 |
| 2 | **§3 数据库** | 每张表的详细用途、读写时机、关联页面（本章是核心） |
| 3 | **§4 磁盘布局** | 哪些数据不在 PG 里、文件管理页管哪些目录 |
| 4 | **§5 前端实现** | 视图组件、状态机、页面文件路径 |
| 5 | **§6–§7 后端与 API** | 服务分层与 HTTP 接口（查具体接口时用） |
| 6 | **§10–§11 环境与部署** | 本地跑起来、环境变量 |

用户向操作说明见同目录 [`manual.md`](manual.md)（使用指南）。

---

## 1. 架构总览

Router 是一套 **LLM 置信度 FAQ 匹配 + RAG 向量检索** 双模式知识问答系统，采用 **monorepo** 结构：Express 后端与 React 前端同仓，生产环境由 Node 单进程同时托管 API 与 SPA 静态资源。

### 1.1 核心能力

| 能力 | 说明 | 主要入口 |
|------|------|----------|
| LLM 置信度匹配 | 将用户问题与 FAQ 列表做语义匹配，返回 Top-K 候选及完整 answer | `POST /ask/confidence/stream` |
| RAG 检索问答 | Embedding + 关键词 + RRF 融合 + Rerank，支持直出/LLM 合成 | `POST /rag/chat`、`POST /rag/search` |
| FAQ 管理 | LLM 库与 RAG 库 CRUD、批量导入、双库互导 | `/knowledge-bases/*`、`/rag/knowledge-bases/*` |
| 文档流水线 | 上传源文件 → 提取 Markdown → LLM 生成问法 → 写入双库 | `/documents/*`、`/markdown-files/*` |
| 召回度测试 | 批量跑问句、记录 Top-1 命中与人工标注 | `recall_tests` 表 + 调试页 |
| 配置中心 | 匹配 profile、模型槽位、提示词、RAG 运行时参数 | `/settings/*` |

### 1.2 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18、TypeScript、Vite 6、TanStack Query、Marked + DOMPurify |
| 后端 | Node.js (ESM)、Express 4、multer、pg |
| 数据库 | PostgreSQL（FAQ、配置、日志、RAG 元数据） |
| 向量库 | Weaviate（可选 `MOCK_WEAVIATE` 本地 mock） |
| 文档提取 | Docling (Python)、mammoth、xlsx、turndown；依赖同级 `model_router` 仓库 |

### 1.3 请求链路（简图）

```
浏览器 (React SPA)
    │ fetch / SSE
    ▼
Express (app.js + ragRoutes.js)
    ├── QuestionsCache ──► PostgreSQL qa_items (kb_type=llm)
    ├── confidenceMatch ──► LLMClient (OpenAI 兼容 API)
    ├── RagRetriever ──► EmbeddingClient + Weaviate + Rerank + RagLlmClient
    ├── QuestionsStore / KbStore ──► PostgreSQL + files/kb_*
    └── 静态资源 / SPA fallback ──► client/dist
```

### 1.4 应用上下文（`createAppContext`）

服务启动时构建共享 `ctx` 对象，包含：

| 字段 | 类型/模块 | 职责 |
|------|-----------|------|
| `settings` | `config.js` | 环境变量聚合 |
| `kbStore` | `KbStore` | LLM 知识库元数据 |
| `cache` | `QuestionsCache` | LLM FAQ 内存索引 |
| `modelsStore` | `ModelsStore` | import / pdf_vlm 等槽位 |
| `matchProfilesStore` | `MatchProfilesStore` | 问答匹配多档 API 配置 |
| `promptsStore` | `PromptsStore` | 置信度/FAQ/PDF-VLM 提示词 |
| `opLog` | `OperationLog` | 操作日志（PG + jsonl） |
| `ragCtx` | `createRagContext()` | RAG 全套子系统 |

---

## 1.5 必读：页面 × 功能 × 数据

本节是**不读代码时的总地图**。后文 §3 会对每张 PostgreSQL 表展开；本节回答「这个功能的数据从哪来、存到哪去」。

### 1.5.1 前端导航树（无 URL 路由）

应用用 `App.tsx` 内 `module` / `debugSub` / `manageSub` 切换页面，**没有** React Router 路径。

| 面包屑示例 | `module` | 子状态 | 前端视图文件 | 作用概述 |
|------------|----------|--------|--------------|--------|
| 首页 / **调试** / **问答** | `debug` | `debugSub=single` | `App.tsx` + `DebugViews.tsx` / `RagDebugViews.tsx` | 单条提问，验证 LLM 匹配或 RAG 检索 |
| 首页 / **调试** / **召回度测试** | `debug` | `debugSub=recall` | `DebugRecallView.tsx` | 批量测试问题，人工标注是否召回 |
| 首页 / **管理** / **问题管理** | `manage` | `manageSub=items` | `ManageView.tsx` → `ManageQuestionsView` | 维护 FAQ、知识库 CRUD |
| 首页 / **管理** / **文件管理** | `manage` | `manageSub=files` | `ManageView.tsx` → `ManageFilesView.tsx` | 上传文档、转 MD、生成 FAQ |
| 首页 / **日志** | `logs` | — | `LogsView.tsx` | 查看操作与调试日志 |
| 首页 / **设置** | `settings` | — | `SettingsView.tsx` | 模型、提示词、RAG 参数 |

顶栏 **使用手册** 打开 `DocsModal`，加载 `manual.md` / 本文档，**不读写业务数据库**。

### 1.5.2 数据存储三分法

| 存储 | 放什么 | 典型内容 |
|------|--------|----------|
| **PostgreSQL** | 结构化业务数据 | FAQ、知识库注册、配置、召回测试、RAG 元数据、日志 |
| **磁盘 `files/`** | 大文件与附件 | 上传 PDF、提取后的 MD、FAQ/文档里的图片 |
| **Weaviate** | RAG 向量索引 | 每条 FAQ 检索用向量，由 `rag_index_meta` 记录构建状态 |

运行时 **FAQ 与配置以 PostgreSQL 为准**；`config/*.json`、`files/kb_*/questions.json` 等仅为首次 seed 或备份。

### 1.5.3 总对照表：页面功能 → 表 / 磁盘 / API

| 页面 · 功能 | 用户操作 | 主要 PostgreSQL 表 | 磁盘 | 主要 API |
|-------------|----------|-------------------|------|----------|
| **调试·问答**（LLM） | 选库、输入问题、提问 | 读 `qa_items`(llm)、`app_settings`(match_profiles/prompts) | — | `POST /ask/confidence/stream` |
| **调试·问答**（RAG） | 选 RAG 库、问答/检索 | 读 `qa_items`(rag)、`rag_runtime_configs`、`rag_index_meta`；向量在 Weaviate | — | `POST /rag/chat`、`POST /rag/search` |
| **调试·召回度** | 编辑测试行、批量运行、保存、标注 | 读写的 **`recall_tests`**；运行时读 `qa_items` | — | `GET/PUT .../recall-tests`；LLM 跑批调 `/ask/confidence`；RAG 跑批调 `/rag/chat` |
| **管理·问题管理** | 左侧选库、增删改 FAQ、JSON 源码保存 | **`llm_knowledge_bases` 或 `rag_knowledge_bases`**（库列表）、**`qa_items`**（条目）、**`qa_documents`**（版本） | `kb_*/assets`、`rag_kb_*/assets`（答案图片） | `/knowledge-bases/*` 或 `/rag/knowledge-bases/*` |
| **管理·问题管理** | RAG 模式「重建索引」 | 写 **`rag_index_meta`**；写 Weaviate | — | `POST /rag/knowledge-bases/:id/index/rebuild` |
| **管理·问题管理** | 从 RAG/LLM 互导 FAQ | 批量写 **`qa_items`** | 同步 assets | `import/from-rag`、`import/from-llm` |
| **管理·文件管理** | 上传、编辑 MD、转 PDF | **不经过 FAQ 表** | **`files/documents/sources|modules|assets`** | `/documents/*`、`/markdown-files/*` |
| **管理·文件管理** | 问题生成 → 导入 FAQ | 写 **`qa_items`**（llm 和/或 rag） | 复制图片到 `kb_*/assets` | `.../import/generate-questions`、`.../import/commit` |
| **设置**（LLM） | 问答模型 profile、FAQ 生成模型、提示词 | **`app_settings`** 键：`match_profiles`、`models`、`prompts` | `config/*.json` 仅 seed | `/settings/match-profiles`、`/settings/models`、`/settings/prompts` |
| **设置**（RAG） | Embedding/Rerank/合成模型、提示词 | **`app_settings`** 键：`rag_models`、`rag_prompts`；每库运行时 **`rag_runtime_configs`** | `config/rag_*.json` 仅 seed | `/settings/rag-*`、`/rag/knowledge-bases/:id/runtime-config` |
| **日志** | 筛选、刷新 | 读 **`operation_logs`** | 镜像追加 `logs/operations.jsonl` | `GET /logs`、`GET /logs/stream` |

### 1.5.4 三条主业务链路（数据怎么流）

**链路 A：LLM 问答（调试·问答 · 问答模型模式）**

```
用户在页面选 kb_1 → GET /knowledge-bases（读 llm_knowledge_bases）
→ 提问 → POST /ask/confidence/stream
→ 服务端 QuestionsCache 从 qa_items(kb_type=llm, kb_id=1) 加载 FAQ 进内存
→ 调 LLM 匹配 → 返回 Top-K 候选 + answer 正文（Markdown）
→ 过程日志写入 operation_logs(module=debug)
```

**链路 B：RAG 问答（调试·问答 · RAG 模式）**

```
用户选 rag_kb_1 → GET /rag/knowledge-bases（读 rag_knowledge_bases）
→ 页面显示 IndexStatusPill → GET .../index/status（读 rag_index_meta，对比 Weaviate）
→ 提问 → POST /rag/chat
→ RagRetriever：Embedding → Weaviate 向量检索 → Rerank → 按 rag_runtime_configs.answer_mode 直出或 LLM 合成
→ FAQ 正文仍来自 qa_items(kb_type=rag)；向量不在 PG 里
```

**链路 C：从 PDF 到 FAQ（文件管理 → 问题管理）**

```
文件管理：POST /documents/upload → 磁盘 sources/
→ ExtractModal：POST /documents/extract/stream → 磁盘 modules/*.md
→ GenerateModal：POST .../import/generate-questions（用 app_settings.models.import）
→ POST .../import/commit → 写入 qa_items + 图片进 kb_*/assets
→ 问题管理页可见新 FAQ；RAG 侧若勾选导入则还需重建索引（rag_index_meta + Weaviate）
```

### 1.5.5 常见问题

| 问题 | 答案 |
|------|------|
| 问题管理里改 JSON 保存，进数据库吗？ | **是**。`PUT .../questions/items/:id` → `qaRepo.upsertItem` → **`qa_items`**。LLM 库保存后会 `reload` 内存索引；RAG 库保存后索引可能变「过期」，需重建。 |
| `llm_knowledge_bases` 和 `qa_items` 区别？ | 前者是**库名片**（id、显示名）；后者是**库里的每一道 FAQ**。 |
| `rag_knowledge_bases` 和 Weaviate 区别？ | 前者是 RAG **库注册**；Weaviate 存**向量**，`rag_index_meta` 记录「索引是否和当前 FAQ 一致」。 |
| 召回度测试存在哪？ | **`recall_tests` 表**，按 `(kb_type, kb_id)` 分库；与 FAQ 表独立。 |
| 文件管理的 MD 在 PG 吗？ | **不在**。在 **`files/documents/modules/`**；只有「导入为 FAQ」后才进 `qa_items`。 |

---

## 2. 项目目录结构 (monorepo client/server)

```
Router/                          # monorepo 根（npm workspaces）
├── package.json                 # workspaces: server, client；scripts: dev/build/start
├── .env / .env.example          # 全局环境变量（DATABASE_URL 等）
├── docker-compose.weaviate.yml  # 可选 Weaviate 本地部署
├── config/                      # JSON 配置（首次可 seed 到 PG）
│   ├── knowledge_bases.json     # LLM 库列表（兼容/备份）
│   ├── rag_knowledge_bases.json
│   ├── match_profiles.json      # 问答模型 profile
│   ├── models.json              # import、pdf_vlm 槽位
│   ├── prompts.json
│   ├── rag_models.json
│   └── rag_prompts.json
├── files/                       # 业务数据根（FILES_ROOT 默认指向此处）
│   ├── documents/               # 文档管理（见第 4 节）
│   ├── kb_{id}/                 # LLM 知识库磁盘目录
│   └── rag_kb_{id}/             # RAG 知识库磁盘目录
├── logs/
│   └── operations.jsonl         # 操作日志追加文件（与 PG 双写）
├── client/                      # 前端 SPA
│   ├── public/
│   │   ├── dev-manual.md        # 本文档
│   │   └── manual.md            # 用户手册
│   ├── src/
│   │   ├── App.tsx              # 根布局与导航状态机
│   │   ├── types.ts             # 共享 TS 类型
│   │   ├── api/client.ts        # fetch + SSE 封装
│   │   ├── hooks/               # React Query 与业务 hooks
│   │   ├── views/               # 页面级视图
│   │   ├── components/          # 可复用 UI 组件（含 FileGridCard、FileGridPanel）
│   │   ├── context/             # Toast/Modal 全局 UI
│   │   └── utils/               # 文档类型、importShared（文件树/侧栏）
│   ├── vite.config.ts           # 开发代理 → :8002
│   └── dist/                    # 生产构建产物
└── server/                      # 后端
    ├── migrations/
    │   └── 001_initial.sql      # PostgreSQL schema
    ├── scripts/                 # db:setup、migrate、seed 等
    └── src/
        ├── index.js             # 启动入口
        ├── app.js               # Express 工厂 + 主路由
        ├── config.js            # loadSettings()
        ├── routes/
        │   └── ragRoutes.js     # RAG 专用路由注册
        ├── db/
        │   ├── pool.js          # pg 连接池
        │   ├── migrate.js       # 迁移 runner
        │   ├── stores/          # 领域 Store（面向业务）
        │   └── repositories/    # SQL 仓储层
        └── services/            # 业务逻辑
            ├── confidenceMatch.js
            ├── questionsCache.js
            ├── fileProcessor.js
            ├── assetSync.js
            ├── markdownFiles.js
            └── rag/             # RAG 子模块
                ├── retriever.js
                ├── indexer.js
                └── weaviateStore.js
```

### 2.1 分层约定

| 层 | 位置 | 说明 |
|----|------|------|
| **Store** | `server/src/db/stores/*` | 对外业务 API：读写字段、触发回调、乐观锁 |
| **Repository** | `server/src/db/repositories/*` | 纯 SQL CRUD，不含业务规则 |
| **Service** | `server/src/services/*` | 匹配、提取、RAG、路径同步等核心算法 |
| **Route** | `app.js` / `ragRoutes.js` | HTTP 绑定、参数校验、SSE 头 |

---

## 3. PostgreSQL 数据库详解

来源：`server/migrations/001_initial.sql`。  
**原则**：FAQ、知识库元数据、配置、召回测试、RAG 运行参数与索引状态 → PostgreSQL；上传的 PDF/MD 原文 → 磁盘 `files/documents/`（见 §4）。

下列每张表均包含：**用途**、**页面/功能**、**读写时机**、**后端代码**、**相关 API**、**列说明**。

---

### 3.0 表一览（按业务分组）

| 分组 | 表名 | 作用概述 |
|------|------|--------|
| 迁移 | `schema_migrations`、`data_migrations` | 记录 DB 结构迁移与 JSON→PG 种子是否跑过 |
| LLM 知识库 | `llm_knowledge_bases` | 问答模型模式下的「知识库列表」 |
| RAG 知识库 | `rag_knowledge_bases` | RAG 模式下的「知识库列表」 |
| FAQ 内容 | `qa_documents`、`qa_items` | 所有标准问/变体问/答案 Markdown（LLM 与 RAG 共用表，靠 `kb_type` 区分） |
| 全局配置 | `app_settings` | 设置页全部模型槽位与提示词（JSON 键值） |
| 日志 | `operation_logs` | 日志页 + 调试 SSE 过程记录 |
| 召回测试 | `recall_tests` | 调试·召回度测试页的测试集与标注 |
| RAG 运行 | `rag_runtime_configs`、`rag_index_meta` | 每 RAG 库的检索/合成参数、向量索引构建元数据 |
| 预留 | `rag_eval_runs` | 表已建，**当前代码未使用** |

---

### 3.1 schema_migrations

**用途**：记录「哪份 SQL 结构迁移已经执行」，防止重复跑 `migrations/*.sql`。

| 维度 | 说明 |
|------|------|
| **UI 页面** | 无。仅运维/开发在部署时由 `npm run db:migrate` 或启动时 `runMigrations()` 写入 |
| **谁读** | `server/src/db/migrate.js` |
| **谁写** | 迁移 runner 每成功执行一个 `.sql` 文件插入一行 |

| 列名 | 类型 | 说明 |
|------|------|------|
| `name` | TEXT PK | 迁移文件名，如 `001_initial.sql` |
| `applied_at` | TIMESTAMPTZ | 应用时间 |

---

### 3.2 data_migrations

**用途**：记录「哪次数据种子任务已完成」，例如首次把 `config/*.json` 导入 PostgreSQL。

| 维度 | 说明 |
|------|------|
| **UI 页面** | 无 |
| **谁写** | `server/src/db/ensureJsonSeeded.js` 在首次启动且 `SKIP_JSON_SEED` 未设置时 |
| **典型任务名** | `json_seed_v1` 等 |

| 列名 | 类型 | 说明 |
|------|------|------|
| `name` | TEXT PK | 数据迁移任务名 |
| `completed_at` | TIMESTAMPTZ | 完成时间 |

---

### 3.3 llm_knowledge_bases

**用途**：**问答模型（LLM 置信度匹配）模式**下的知识库注册表——相当于「有哪些 kb_1、kb_2…，各自叫什么名字」。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **管理 → 问题管理**，左侧 FAQ 模式选 **问答模型** 时的「知识库」列表 |
| **UI · 页面** | **调试 → 问答**，模式选 **问答模型** 时的知识库下拉 |
| **UI · 页面** | **调试 → 召回度测试**，模式选 **问答模型** 时的知识库下拉 |
| **UI · 操作** | 「操作 → 新增/重命名/删除知识库」「从 RAG 导入 FAQ」「重新加载索引」 |
| **谁读** | `KbStore` → `kbRepo.listLlm()`；`GET /knowledge-bases` |
| **谁写** | `POST /knowledge-bases`、`POST .../rename`、`DELETE ...`；删除库时级联删该库 `qa_items`、`recall_tests` |
| **磁盘** | 创建库时 `mkdir files/kb_{id}/` 与 `assets/`（FAQ 图片），**库列表本身在 PG** |
| **与 FAQ 关系** | 本表**不含** FAQ 正文；正文在 **`qa_items`**（`kb_type='llm'`） |

| 列名 | 类型 | 说明 |
|------|------|------|
| `kb_id` | TEXT PK | 知识库 ID，如 `"1"`；UI 显示为 `kb_1` |
| `name` | TEXT | 显示名称，如「示例知识库」 |
| `match_prompt` | TEXT | 库级匹配备注（扩展字段，通常空） |
| `status` | TEXT | 状态，默认 `ready` |
| `created_at` / `updated_at` | TIMESTAMPTZ | 创建/更新时间 |

**删除库时**：`kbRepo.deleteLlmKb` 同时删除该 `kb_id` 下所有 `qa_items`(llm)、`recall_tests`(llm) 及磁盘 `files/kb_{id}/`。

---

### 3.4 rag_knowledge_bases

**用途**：**RAG 向量检索模式**下的知识库注册表——与 `llm_knowledge_bases` 平行，ID 空间独立（如 `rag_kb_1`）。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **管理 → 问题管理**，FAQ 模式选 **RAG** 时的左侧「RAG 知识库」列表 |
| **UI · 页面** | **调试 → 问答 / 召回度**，RAG 模式下的知识库下拉 |
| **UI · 操作** | 新增/重命名/删除 RAG 库；「从问答模型导入 FAQ」 |
| **谁读** | `RagKbStore` → `GET /rag/knowledge-bases` |
| **谁写** | `POST /rag/knowledge-bases`、`POST .../rename`、`DELETE ...` |
| **磁盘** | `files/rag_kb_{id}/` + `assets/` |
| **与向量** | 向量在 **Weaviate**；本表只登记「有哪些 RAG 库」 |

| 列名 | 类型 | 说明 |
|------|------|------|
| `kb_id` | TEXT PK | RAG 库 ID |
| `name` | TEXT | 显示名称 |
| `status` | TEXT | 默认 `ready` |
| `created_at` / `updated_at` | TIMESTAMPTZ | 时间戳 |

**删除 RAG 库时**：级联删 `qa_items`(rag)、`recall_tests`(rag)、`rag_runtime_configs`、`rag_index_meta`，并清 Weaviate 中该库向量。

---

### 3.5 qa_documents

**用途**：每个知识库 FAQ 集合的**文档级元数据**，目前主要用于 **version 乐观锁**（整库替换 FAQ 时递增版本）。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **管理 → 问题管理** 间接使用：加载 FAQ 时 `GET .../questions` 返回 `{ version, items }` |
| **UI · 操作** | 用户很少直接感知；批量 `PUT .../questions` 全量替换时比对 version |
| **谁读/写** | `qaRepo.getDocument`、`qaRepo.replaceAll` |
| **一行含义** | 每个 `(kb_type, kb_id)` 最多一行，对应一个知识库的 FAQ 文档 |

| 列名 | 类型 | 说明 |
|------|------|------|
| `kb_type` | TEXT | `'llm'` 或 `'rag'` |
| `kb_id` | TEXT | 所属知识库 ID |
| `version` | INT | 文档版本，全量替换时 +1 |
| `updated_at` | TIMESTAMPTZ | 文档更新时间 |
| **PK** | | `(kb_type, kb_id)` |

---

### 3.6 qa_items（核心 FAQ 表）

**用途**：存储**每一条 FAQ**——标准问、变体问、答案 Markdown、是否启用。LLM 与 RAG **共用一张表**，用 `kb_type` 区分。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **管理 → 问题管理**：中间「标准问题」卡片列表、右侧问题编辑器（含 **JSON 源码** Tab） |
| **UI · 操作** | 新增/编辑/删除/启用/禁用 FAQ；**JSON 源码保存**与表单保存走同一 API |
| **UI · 页面** | **调试 → 问答**：LLM 模式读 llm 库；RAG 模式检索后展示的 answer 来自 rag 库 |
| **UI · 页面** | **管理 → 文件管理 → 问题生成 → 导入**：`POST .../import/commit` 批量插入 |
| **谁读** | `QuestionsStore.getDocument` / `getItem`；LLM 侧 `QuestionsCache.loadKb` 载入内存 |
| **谁写** | `upsertItem`、`deleteItem`、`replaceAll`；`qaRepo.validateItems` 校验 question/answer 非空 |
| **保存后** | LLM：`cache.reloadKb` 立即生效；RAG：`markIndexStale`，需 **重建索引** |
| **磁盘** | 答案内 `![](assets/x.png)` → `files/kb_{id}/assets/` 或 `rag_kb_{id}/assets/` |

| 列名 | 类型 | 说明 |
|------|------|------|
| `kb_type` | TEXT | `'llm'` \| `'rag'` |
| `kb_id` | TEXT | 知识库 ID |
| `item_id` | TEXT | 条目 ID，如 `q001`（API JSON 字段名为 `id`） |
| `question` | TEXT | 标准问法 |
| `variants` | JSONB | 变体问法字符串数组 |
| `answer` | TEXT | 答案 Markdown |
| `enabled` | BOOLEAN | 是否参与匹配/建索引 |
| `updated_at` | TIMESTAMPTZ | 条目更新时间 |

**JSON 源码保存路径（问题管理页）**：

```
用户编辑 JSON → ManageQuestionsView.saveEditor()
→ PUT /knowledge-bases/:kbId/questions/items/:itemId  （或 RAG 路径）
→ QuestionsStore.upsertItem → qaRepo.upsertItem → INSERT/UPDATE qa_items
```

---

### 3.7 app_settings

**用途**：**键值配置表**，存设置页所有可持久化 JSON 配置（一行一个 key）。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **设置**（LLM / RAG 两个 Tab 共用此表，不同 key） |
| **Store 映射** | 见下表 |

| `key` | 设置页内容 | 还影响哪些功能 |
|-------|------------|--------------|
| `match_profiles` | 问答模型 **Profile 列表**（多套 API/模型） | **调试·问答** LLM 模式 profile 下拉；**召回度** LLM 跑批 |
| `models` | **FAQ 生成**、**文档提取/VLM** 槽位 | **文件管理 → 问题生成**；**文件转 Markdown** |
| `prompts` | 置信度匹配、FAQ 生成、PDF-VLM 提示词 | LLM 匹配 system prompt；生成问法 |
| `rag_models` | Embedding、Rerank、RAG 合成模型 | **调试·问答** RAG；索引 rebuild |
| `rag_prompts` | RAG 侧提示词（含合成回答 template） | `POST /rag/chat` 合成模式 |

| 列名 | 类型 | 说明 |
|------|------|------|
| `key` | TEXT PK | 配置键名 |
| `value` | JSONB | 配置 JSON 全文 |
| `updated_at` | TIMESTAMPTZ | 更新时间 |

**首次部署**：`ensureJsonSeeded.js` 从 `config/match_profiles.json` 等写入；之后 **设置页「保存全部」只写 PG**，不自动回写 JSON 文件。

---

### 3.8 operation_logs

**用途**：系统**操作与调试日志**——问答过程、管理操作、RAG 分步、文件上传等。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **日志**（`LogsView.tsx`）：按 module/kb/时间筛选 |
| **UI · 筛选** | 下拉：问答模型(`debug`)、RAG(`rag-debug` 等)、问题管理、文件管理、问题生成、设置 |
| **谁写** | `OperationLog.append`：问答 SSE、召回保存、索引重建、导入 commit 等 |
| **双写** | 同时追加 `logs/operations.jsonl`（备份） |
| **增量** | `GET /logs/stream?since=` SSE 推送新行 |

| 列名 | 类型 | 说明 |
|------|------|------|
| `id` | BIGSERIAL PK | 自增 |
| `ts` | TIMESTAMPTZ | 时间戳 |
| `level` | TEXT | 如 `info` |
| `module` | TEXT | `debug`、`manage`、`files`、`rag-debug` 等 |
| `action` | TEXT | `step`、`save_recall_tests`、`rebuild` 等 |
| `kb_id` | TEXT | 关联知识库 |
| `detail` | TEXT | 人类可读说明 |
| `kind` | TEXT | `log`、`step`、`result` |
| `extra` | JSONB | 扩展（如 token 统计） |

---

### 3.9 recall_tests

**用途**：**召回度测试**专用数据集——与 FAQ 分离，存「测试问题、跑批结果、人工标注是否召回」。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **调试 → 召回度测试**（`DebugRecallView.tsx` / `RecallModule`） |
| **UI · 操作** | 添加/导入问题、**批量运行**、查看 LLM/RAG 回答、标注是/否/未标注、**保存**、导出 Markdown |
| **谁读** | `GET /knowledge-bases/:id/recall-tests` 或 RAG 同名路径 |
| **谁写** | 用户点 **保存** → `PUT .../recall-tests` 整表替换该库测试行 |
| **跑批时** | 不直接写 FAQ；更新行的 `last_top_id`、`last_confidence`、`run_at` 等 |
| **按库隔离** | `(kb_type, kb_id)` — LLM 库与 RAG 库各有一套测试集 |

| 列名 | 类型 | 说明 |
|------|------|------|
| `kb_type` | TEXT | `'llm'` \| `'rag'` |
| `kb_id` | TEXT | 知识库 ID |
| `row_id` | TEXT | 测试行 ID |
| `question` | TEXT | 测试问题文本 |
| `recalled` | TEXT | 人工标注：`''` / `'yes'` / `'no'` |
| `run_at` | TIMESTAMPTZ | 最近跑批时间 |
| `last_top_id` | TEXT | 最近 Top-1 命中 FAQ 的 `item_id` |
| `last_confidence` | REAL | 最近 Top-1 分数（LLM 置信度或 RAG rerank 分） |
| `notes` | TEXT | 备注 |
| `match_profile_id` | TEXT | LLM 跑批用的 profile |
| `model_label` | TEXT | 展示用模型名 |
| `sort_order` | INT | 列表排序 |

---

### 3.10 rag_runtime_configs

**用途**：**每个 RAG 知识库一份**的运行时检索/合成参数（Top K、直出/合成、最低置信度等）。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | 主要在 **调试 → 问答** RAG 模式间接生效；高级项可通过 API 调整 |
| **谁读** | `RagRetriever` 每次 `search`/`chat` 读 `rag_runtime_configs.config` |
| **谁写** | `PUT /rag/knowledge-bases/:id/runtime-config`；新建 RAG 库时写默认值 |
| **默认值** | `top_k: 8`、`answer_mode: "direct"`、`min_confidence_score: 0.05` 等（见 `ragRuntimeConfigStore.js`） |

| 列名 | 类型 | 说明 |
|------|------|------|
| `kb_id` | TEXT PK FK | 关联 `rag_knowledge_bases` |
| `config` | JSONB | 运行时参数 JSON |
| `updated_at` | TIMESTAMPTZ | 更新时间 |

**`answer_mode` 含义**：`direct` = 直出 Top1 FAQ 答案；`generated` = 调 RAG 合成 LLM 生成答案。

---

### 3.11 rag_index_meta

**用途**：记录 RAG **向量索引**的构建元数据——是否与当前 FAQ、Embedding 模型一致（**索引就绪 / 过期** 的来源）。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **管理 → 问题管理**（RAG 模式）顶栏 **IndexStatusPill**「索引就绪 / 索引过期 / 未构建」 |
| **UI · 页面** | **调试 → 问答** RAG 模式右侧索引状态 |
| **UI · 操作** | **重建索引** → `POST .../index/rebuild` → 读 FAQ from `qa_items` → 写 Weaviate → 更新本表 `meta` |
| **谁读** | `GET .../index/status`、`GET /rag/health` |
| **向量数据** | 在 **Weaviate**，不在 PostgreSQL |

| 列名 | 类型 | 说明 |
|------|------|------|
| `kb_id` | TEXT PK FK | RAG 库 ID |
| `meta` | JSONB | 如 `items` 数量、`search_docs`、`embedding_model`、`built_at` |
| `updated_at` | TIMESTAMPTZ | 更新时间 |

**FAQ 变更后**：修改 `qa_items`(rag) 会 mark stale；必须重建索引后 RAG 问答/检索才用新 FAQ。

---

### 3.12 rag_eval_runs

**用途**：预留的 RAG **批量评估运行**记录表。

| 维度 | 说明 |
|------|------|
| **UI · 页面** | **当前无页面使用** |
| **代码** | 仅 migration 建表；无 repository 引用 |
| **接手建议** | 可忽略，除非后续做 RAG 评测批跑功能 |

| 列名 | 类型 | 说明 |
|------|------|------|
| `kb_id` | TEXT | RAG 库 ID |
| `run_id` | TEXT | 运行 ID |
| `data` | JSONB | 评估结果 |
| `created_at` / `updated_at` | TIMESTAMPTZ | 时间戳 |
| **PK** | | `(kb_id, run_id)` |

---

## 4. 磁盘文件布局

默认根目录：`FILES_ROOT` → `{DATA_ROOT}/files` → 仓库内 `Router/files/`。

**与 PostgreSQL 的分工**：FAQ 正文、知识库名称、配置、召回测试 → **PG**；本节目录存**大文件与附件**。
文件管理页操作的内容**几乎全在磁盘**，只有「导入 FAQ」才写入 `qa_items`。

| 磁盘路径 | 对应 UI 页面 | 典型操作 |
|----------|--------------|----------|
| `files/documents/sources/` | **管理 → 文件管理** | 上传 PDF/DOCX/… |
| `files/documents/modules/` | **管理 → 文件管理** | 转 MD、新建 MD、编辑保存 |
| `files/documents/assets/` | 文件管理预览、FAQ 预览 | 提取/文档内图片 |
| `files/kb_{id}/assets/` | **问题管理**（LLM）、调试问答预览 | FAQ 答案内图片 |
| `files/rag_kb_{id}/assets/` | **问题管理**（RAG） | 同上 |
| `files/kb_{id}/questions.json` | 无（备份/seed） | 首次 `db:seed` 导入 PG |
| `config/*.json` | **设置** seed 来源 | 运行时读 PG `app_settings` |

### 4.1 documents（文档管理）

```
files/documents/
├── sources/          # 用户上传的原始文件（PDF/DOCX/XLSX/MD/…）
├── modules/          # 提取或手工创建的 Markdown 模块
└── assets/           # 文档提取产生的图片（与 modules 内 MD 引用对应）
```

- **sources**：`POST /documents/upload` 写入；文件名 basename 唯一，中文名经 `decodeUploadFilename` 修正。
- **modules**：`POST /documents/extract/stream` 或 `POST /markdown-files` 产出；相对路径如 `documents/modules/foo.md`。
- **assets**：提取时从临时目录合并复制；Markdown 内引用格式 `![](assets/xxx.png)`。

### 4.2 kb_{id}（LLM 知识库）

```
files/kb_1/
├── questions.json       # 兼容/备份（seed 来源）
├── recall_tests.json    # LLM 召回度测试集
└── assets/              # FAQ answer 内引用的图片（import/commit 时 sync）
```

- 创建库时 `app.js` 自动 `mkdirSync` `kbDirPath` 与 `kbAssetsDirPath`。
- `QuestionsStore.open("llm", kbId)` 读写 PostgreSQL，JSON 文件仅迁移用。

### 4.3 rag_kb_{id}（RAG 知识库）

```
files/rag_kb_1/
├── questions.json
├── recall_tests.json
├── runtime_config.json  # 运行时参数镜像（PG rag_runtime_configs）
├── index_meta.json      # 索引元数据镜像
└── assets/              # RAG answer 图片
```

- 旧版 `files/kb_{id}/rag/` 会在启动时迁移到 `rag_kb_{id}/`（`migrateLegacyRagKbData`）。

### 4.4 config/ 与 logs/

| 路径 | 用途 |
|------|------|
| `config/knowledge_bases.json` | LLM 库列表（PG 为主，JSON 为 seed） |
| `config/match_profiles.json` | 问答模型多 profile |
| `config/models.json` | `import`、`pdf_vlm` 槽位 |
| `config/prompts.json` | 全局提示词 |
| `config/rag_*.json` | RAG 模型与提示词 |
| `logs/operations.jsonl` | 操作日志 JSONL 追加 |

---

## 5. 前端实现

### 5.1 App.tsx 导航状态机

App 使用 **一级 module × 二级 sub** 控制视图，无 React Router，纯 `useState` 切换。

#### 5.1.1 状态变量

| 状态 | 类型 | 默认值 | 作用 |
|------|------|--------|------|
| `module` | `ModuleName` | `"debug"` | 一级：`debug` \| `manage` \| `logs` \| `settings` |
| `debugSub` | `DebugSub` | `"single"` | 调试二级：`single`（问答）\| `recall`（召回度） |
| `manageSub` | `ManageSub` | `"items"` | 管理二级：`items`（问题）\| `files`（文件） |
| `debugMode` | `AskMode` | `"llm"` | 问答模式：`llm` \| `rag` |
| `debugKb` / `debugRagKb` | string | `""` | 当前选中知识库（空则 fallback 列表首项） |
| `debugProfile` | string | `""` | 问答模型 profile id |
| `debugTopK` | number | `5` | Top K，范围 1–20 |
| `question` | string | `""` | 输入框内容 |

#### 5.1.2 切换函数 `switchModule(m, sub?)`

```
switchModule("debug", "single")  → module=debug, debugSub=single, 渲染问答布局
switchModule("debug", "recall")  → 渲染 RecallModule
switchModule("manage")           → manageSub 默认 items
switchModule("manage", "files")  → ManageFilesView
switchModule("logs")             → LogsView
switchModule("settings")         → SettingsView
```

#### 5.1.3 布局分支

| 条件 | 布局类 | 内容 |
|------|--------|------|
| `module=="debug" && debugSub=="single"` | `withAskLayout` | 三栏：会话历史 / 聊天线程 / 候选导航 |
| `module=="debug" && debugSub=="recall"` | `withLeft` | RecallModule 双栏 |
| `manage` / `logs` / `settings` | 单栏 `mainContent` | 对应 View 全宽 |

快捷键：`Ctrl+Enter` 在调试·问答页触发 `submitAsk()`。

### 5.2 视图文件职责（页面级详解）

下表按 **用户可见页面** 列出：前端文件、读写的数据、关键 API。接手时可按页面查代码。

| 面包屑 | 视图文件 | 读 PG 表 | 读/写磁盘 | 关键 API |
|--------|----------|----------|-----------|----------|
| 调试 / 问答 | `App.tsx` + `DebugViews.tsx`（LLM） | `qa_items`(llm)、`app_settings` | — | `POST /ask/confidence/stream` |
| 调试 / 问答 | `App.tsx` + `RagDebugViews.tsx`（RAG） | `qa_items`(rag)、`rag_index_meta`、`rag_runtime_configs` | — | `POST /rag/chat`、`/rag/search` |
| 调试 / 召回度 | `DebugRecallView.tsx` | **`recall_tests`**；跑批时读 `qa_items` | — | `GET/PUT .../recall-tests` |
| 管理 / 问题管理 | `ManageView.tsx` → `ManageQuestionsView` | **`llm_knowledge_bases` 或 `rag_knowledge_bases`**、**`qa_items`** | `kb_*/assets` | `/knowledge-bases/*` 或 `/rag/knowledge-bases/*` |
| 管理 / 文件管理 | `ManageFilesView.tsx` | 导入 FAQ 时写 **`qa_items`** | **`documents/*`** | `/documents/*`、`/markdown-files/*` |
| 日志 | `LogsView.tsx` | **`operation_logs`** | `logs/operations.jsonl`（镜像） | `GET /logs`、`/logs/stream` |
| 设置 | `SettingsView.tsx` | **`app_settings`**（5 个 key） | — | `/settings/*` |

#### 5.2.1 管理 · 问题管理（`ManageQuestionsView`）数据流

```
左侧 ModeBar 切换 llm/rag
  → useKnowledgeBases / useRagKnowledgeBases
  → GET /knowledge-bases 或 /rag/knowledge-bases
  → 读 llm_knowledge_bases 或 rag_knowledge_bases

选中库 → GET .../questions
  → qa_documents.version + qa_items 列表

编辑 FAQ（表单或 JSON 源码）→ 保存
  → PUT .../questions/items/:id
  → qa_items 单行更新
  → LLM: POST .../reload 或 cache.reloadKb
  → RAG: 索引标记过期，需 IndexStatusPill 重建

RAG 重建索引
  → POST /rag/knowledge-bases/:id/index/rebuild
  → 读 qa_items(rag) → Weaviate → 写 rag_index_meta
```

#### 5.2.2 原视图文件索引

| 文件 | 职责 |
|------|------|
| `App.tsx` | Provider 树、侧边栏、顶栏健康状态、问答/管理/日志/设置路由 |
| `views/DebugViews.tsx` | LLM 模式：`LlmTurnSection`、`useDebugAsk`；SSE 解析 candidates/done |
| `views/RagDebugViews.tsx` | RAG 模式：`RagTurnSection`；调用 `/rag/chat`、`/rag/search` |
| `views/DebugRecallView.tsx` | `RecallModule`：召回度批量测试 |
| `views/ManageView.tsx` | 管理壳 + `ManageQuestionsView` / `ManageFilesView` |
| `views/ManageFilesView.tsx` | 文件网格/预览、ExtractModal、GenerateModal |
| `views/LogsView.tsx` | 日志列表 + SSE |
| `views/SettingsView.tsx` | LLM/RAG 设置 Tab |

### 5.3 组件、Hooks、API 客户端

#### 5.3.1 核心 Hooks

| Hook | 文件 | 说明 |
|------|------|------|
| `useHealth` | `hooks/useKnowledgeBases.ts` | 7s 轮询 `GET /health` |
| `useKnowledgeBases` | 同上 | LLM 库列表 + `kbMap` + `refresh` |
| `useRagKnowledgeBases` | 同上 | RAG 库列表 |
| `useMatchProfiles` | 同上 | 问答模型 profile |
| `useAskSessions` | `hooks/useAskSessions.ts` | 多会话聊天状态；localStorage 7 天 |
| `useDebugQuestions` | `DebugViews.tsx` | 从 FAQ 随机抽样问题 |

#### 5.3.2 API 客户端（`api/client.ts`）

| 函数 | 用途 |
|------|------|
| `apiJson<T>(url, options)` | 通用 REST JSON；失败抛 `detail` |
| `consumeSseStream(resp, onEvent, {signal})` | SSE 流解析 |
| `streamAskConfidence(body, onEvent)` | `POST /ask/confidence/stream`，180s 超时 |
| `streamDocumentExtract(body, onEvent)` | `POST /documents/extract/stream`，无客户端超时 |

#### 5.3.3 主要组件

| 组件 | 文件 | 页面位置 |
|------|------|---------------------------|
| `AskComposer` | `components/AskComposer.tsx` | **调试 → 问答**：无历史时居中 hero 输入区；有对话后 **底部** 紧凑输入条（含 textarea + 配置 + 提问/清空） |
| `AskConfigPopover` | `components/AskConfigPopover.tsx` | **调试 → 问答**：嵌在 `AskComposer` 左下角 **⚙ 配置按钮** 弹层内（模式、知识库、Profile、TopK；RAG 时含 `IndexStatusPill`） |
| `AskChatThread` | `components/AskChatThread.tsx` | **调试 → 问答**：有对话时 **中间主栏** 滚动区，渲染多轮问答卡片（LLM/RAG turn 由 `DebugViews` / `RagDebugViews` 注入） |
| `GroupedAnswerNavPanel` | `components/AnswerNavPanel.tsx` | **调试 → 问答**：有候选结果时 **最右侧栏**，标题「候选条目」，点击锚点滚动到对应 answer 卡片 |
| `MarkdownPreview` | `components/MarkdownPreview.tsx` | **多处**：调试问答 answer 卡片正文；召回度测试结果弹层；问题管理右侧编辑器预览 Tab；文件管理预览/问题生成弹窗；`DocumentEditorPane` / `MarkdownEditor` 内部 |
| `MarkdownEditor` | `components/MarkdownEditor.tsx` | **管理 → 问题管理**：选中 FAQ 后 **右侧编辑区**（源码 / 预览 Tab，预览 Tab 内用 `MarkdownPreview`） |
| `DocumentEditorPane` | `components/DocumentEditorPane.tsx` | **管理 → 文件管理**：`mainView=file` 时 **全宽主区**（PDF iframe、Markdown 源码、HTML 预览） |
| `FileGridPanel` | `components/FileGridPanel.tsx` | **管理 → 文件管理**：`mainView=grid` 时 **右侧主区**，按「已上传 / 转换 md」分组的三列网格 |
| `FileGridCard` | `components/FileGridCard.tsx` | **管理 → 文件管理**：网格内 **单个文件卡片**（由 `FileGridPanel` 渲染；点击进 file 视图） |
| `FileCategorySidebar` | `utils/importShared.tsx` | **管理 → 文件管理**：`mainView=grid` 时 **左侧栏** 两个分类气泡 + 文件列表（点击滚动定位右侧卡片） |
| `IndexStatusPill` | `components/IndexStatusPill.tsx` | ① **管理 → 问题管理**（RAG 模式）：中间栏顶 **「RAG 标准问题」** 行右侧；② **调试 → 问答**（RAG）：`AskConfigPopover` 内；③ **调试 → 召回度**（RAG）：右侧 **「问答」Tab** 知识库下方 |
| `ImportTargetSwitch` | `components/ImportTargetSwitch.tsx` | **管理 → 文件管理 → 问题生成弹窗**（`GenerateModal`）：底部 **「导入到问答模型 / 导入到 RAG」** 两个开关 |

| 组件 | 职责（简要） |
|------|--------------|
| `AskComposer` | 问题输入、模式切换、KB/profile/TopK 选择 |
| `AskChatThread` | 渲染 LLM/RAG 多轮 turn |
| `GroupedAnswerNavPanel` | 右侧候选条目锚点导航 |
| `MarkdownPreview` | Markdown → HTML（DOMPurify 消毒） |
| `DocumentEditorPane` | 文件预览/编辑（PDF iframe、Markdown 源码、HTML 预览） |
| `FileGridCard` | 文件网格单卡片：类型图标、元信息、⋮ 重命名/删除 |
| `FileGridPanel` | 分组 3 列网格 + scroll 高亮联动 |
| `IndexStatusPill` | RAG 索引状态 + 重建按钮 |
| `ImportTargetSwitch` | 导入目标 LLM/RAG 双选 |

### 5.4 ManageFilesView 文件管理 UI

文件管理页采用 **双视图状态机**（`mainView: "grid" | "file"`），无 React Router 子路径。

#### 5.4.1 状态变量（`ManageFilesView.tsx`）

| 状态 | 类型 | 说明 |
|------|------|------|
| `mainView` | `"grid" \| "file"` | 网格浏览 vs 单文件预览/编辑 |
| `tree` | `FileTreeNode[]` | `GET /markdown-files/tree` |
| `selected` | `{ path, kind, name } \| null` | 当前选中文件（网格高亮 + 预览上下文） |
| `scrollTargetPath` | `string \| null` | 左侧列表点击后滚动定位的网格卡片 |
| `markdown` / `loadedContent` | `string` | 编辑器内容与脏检查基线 |
| `editMode` | `"source" \| "preview"` | 可编辑文件的编辑/预览切换 |
| `extractOpen` / `generateOpen` | `boolean` | 转 MD / 问题生成弹窗 |

#### 5.4.2 视图与布局

```
grid 视图（默认）
├── stripHead：新建 MD | 刷新 | 上传文件
├── filesLayout（左栏 + 右栏）
│   ├── FileCategorySidebar（左）
│   └── FileGridPanel（右，分组 3 列网格）
└── 点击网格卡片 → mainView = "file"

file 视图（预览/编辑）
├── stripHead：返回 + 文件名（左）| 转 MD / 问题生成 / 保存 / 编辑·预览（右）
├── filesLayoutFileView（无左栏，全宽）
└── DocumentEditorPane
```

| 组件 | 文件 | 职责 |
|------|------|------|
| `FileCategorySidebar` | `utils/importShared.tsx` | 两个气泡 + 可折叠文件列表；`onScrollToFile` 滚动定位，**不**加载内容 |
| `FileGridPanel` | `components/FileGridPanel.tsx` | `unwrapDocumentSections` → sources/modules 分组网格 |
| `FileGridCard` | `components/FileGridCard.tsx` | 单卡片 + ⋮ 菜单；`onOpen` → `selectFile()` |
| `DocumentEditorPane` | `components/DocumentEditorPane.tsx` | 预览/编辑渲染 |

#### 5.4.3 左侧分类气泡

`unwrapDocumentSections(tree)` 从 API 树拆出：

- `sources`：`documents/sources/` 下文件 → 气泡 **已上传文件**
- `modules`：`documents/modules/` 下文件 → 气泡 **转换 md 文件**

气泡显示文件数量，可折叠；空分类仍显示气泡（count=0 时不渲染列表 body）。

`renderDocumentFileTree()` 仍用于 **弹窗内**（当 `hideFileTree=false` 时）及历史兼容；主页面侧栏改用 `FileCategorySidebar`。

#### 5.4.4 工具栏分支

| `mainView` | 顶栏按钮 |
|------------|----------|
| `grid` | 新建 MD、刷新、上传文件 |
| `file` | 返回、文件名；右侧按 `canConvertKind` / `canQuestionGenKind` / `isEditableKind` 显示转 MD、问题生成、保存、编辑/预览 |

预览/编辑视图 **隐藏** 左栏（`filesLayoutFileView`）及网格专用按钮。

#### 5.4.5 弹窗（ExtractModal / GenerateModal）

内联于 `ManageFilesView.tsx`，从文件视图打开时传 `hideFileTree`：

- 不渲染左侧 `generateTreeCol` 文件树
- 布局类 `generateLayout noFileTree`：两栏（范围选择 + 内容预览）
- `initialPath` / `initialKind` / `initialMarkdown` 绑定当前 `selected`

弹窗内 `treeFilter`：`"convert"`（仅可转换源文件）、`"questionGen"`（可生成 FAQ 的文件）。

#### 5.4.6 典型工作流

```
上传 POST /documents/upload
  → 网格「已上传文件」出现新卡片
  → 点击卡片 → file 视图
  → ExtractModal（hideFileTree）POST /documents/extract/stream
  → 网格「转换 md 文件」出现 .md；可继续 file 视图编辑
  → GenerateModal（hideFileTree）POST .../import/generate-questions + .../import/commit
  → 问题管理页可见新 FAQ；RAG 侧可选自动 rebuildIndex
```

---

## 6. 后端实现

### 6.1 index.js 启动流程

```javascript
// server/src/index.js
1. loadSettings()           // 读 Router/.env
2. 校验 DATABASE_URL
3. runMigrations()          // 执行 migrations/*.sql
4. verifyConnection()       // pg ping
5. ensureJsonSeeded()       // 首次 JSON → PostgreSQL
6. createAppContext()       // 初始化 Store、Cache、RAG
7. createApp(ctx, clientDist)
8. app.listen(PORT, HOST)   // 默认 8002
```

### 6.2 app.js vs ragRoutes.js

| 模块 | 职责 |
|------|------|
| **app.js** | Express 工厂；LLM 匹配、LLM 库 CRUD、文档、设置、日志、静态资源；调用 `registerRagRoutes(app, ctx, ragCtx)` |
| **ragRoutes.js** | 纯 RAG 路由：RAG 库 CRUD、索引 rebuild/status、search/chat、RAG 设置、runtime-config |

分离原因：RAG 子系统依赖 `ragCtx`（Weaviate、EmbeddingClient 等），独立文件便于测试与维护。

### 6.3 db/stores 与 repositories

| Store | Repository | 说明 |
|-------|------------|------|
| `KbStore` | `kbRepo` | LLM 知识库 CRUD |
| `RagKbStore` | `kbRepo` (rag) | RAG 知识库 CRUD |
| `QuestionsStore` | `qaRepo` | FAQ 条目（llm/rag 分 kb_type） |
| `PromptsStore` | `settingsRepo` | 全局提示词 |
| `ModelsStore` | `settingsRepo` | 模型槽位 |
| `MatchProfilesStore` | `settingsRepo` | 匹配 profile |
| `OperationLog` | `operationLogsRepo` | 日志双写 PG + jsonl |
| `RagRuntimeConfigStore` | `ragMetaRepo` | RAG 运行时配置 |

Store 面向路由/服务；Repository 仅执行 SQL。

### 6.4 核心服务

#### 6.4.1 confidenceMatch.js

- **`runConfidenceMatch(opts)`**：LLM 匹配主流程  
  1. `QuestionsCache.getIndex/loadKb`  
  2. 拼装 system prompt（规则 + FAQ 列表）  
  3. `LLMClient.chatStream` 流式调用  
  4. `parseConfidenceRaw` 解析 JSON 候选  
  5. `cache.resolveItem` 取 answer  
- **`AskLogSink`**：日志写入 SSE 队列 + `operation_logs`
- **`sseEvent(event, data)`**：格式化为 SSE 帧

#### 6.4.2 QuestionsCache

- 启动时 `loadAll()` 预热所有 LLM 库索引。
- 每库索引含：`itemsById`、`enabledItems`、`validIds`、`confidenceSystemPrompt`、`loadedAt`。
- FAQ 变更后 `reloadKb()`；提示词变更时 `promptsStore` 回调 `reloadAll()`。

#### 6.4.3 RagRetriever（`services/rag/retriever.js`）

- **`search(query, topK)`**：embed → Weaviate 向量 → 关键词 n-gram → RRF → rerank。
- **`chat(query, opts)`**：先 search，再按 `min_confidence_score` 与 `answer_mode`（direct/generated）返回答案。

#### 6.4.4 fileProcessor.js

- **`extractPdfToMarkdown`**：调用 Docling Python 脚本（`model_router/scripts/docling_extract_pages.py`）。
- **`extractSourceToMarkdown`**：DOCX/Excel/HTML 转换 + 可选 VLM 精修。
- **`extractMarkdownRange`**：纯文本/Markdown 按行切片。
- **`finalizeCombinedExtract`**：多段 range 合并为单个 module 文件。

#### 6.4.5 assetSync.js

- **`normalizeAssetRef`**：统一为 `assets/{filename}` 相对路径。
- **`syncAnswerAssetsToKb`**：FAQ commit 时将图片从 documents/kb_*/rag_kb_* 复制到目标库 `assets/`。
- **`rewriteAssetPathsInText`**：导入前规范化 Markdown 内图片路径。

---

## 7. API 完整参考

通用错误响应：`{ "detail": "错误说明" }`。  
带 `kb_id` 的接口会校验库存在，否则 **404**。

### 7.0 API 分组与页面对照（速查）

不读代码时，可按 **页面** 反查应关注的 API 组；详细字段见下文各小节。

| 页面 · 功能 | API 前缀 / 关键路径 | 读写的主要 PG 表 |
|-------------|---------------------|------------------|
| **调试 · 问答**（LLM） | `POST /ask/confidence/stream` | 读 `qa_items`(llm)、`app_settings` |
| **调试 · 问答**（RAG） | `POST /rag/chat`、`POST /rag/search`、`GET /rag/health` | 读 `qa_items`(rag)、`rag_runtime_configs`、`rag_index_meta` |
| **调试 · 召回度** | `GET/PUT .../recall-tests`；跑批仍调上面问答 API | **`recall_tests`** |
| **管理 · 问题管理**（LLM） | `/knowledge-bases/*`、`.../questions/*`、`.../import/*` | **`llm_knowledge_bases`**、**`qa_items`**、**`qa_documents`** |
| **管理 · 问题管理**（RAG） | `/rag/knowledge-bases/*`、`.../index/rebuild`、`.../index/status` | **`rag_knowledge_bases`**、**`qa_items`**、**`rag_index_meta`** |
| **管理 · 文件管理** | `/documents/*`、`/markdown-files/*`、`.../import/generate-questions` | 磁盘为主；commit 时写 **`qa_items`** |
| **设置** | `/settings/*`、`/rag/settings/*` | **`app_settings`** |
| **日志** | `GET /logs`、`GET /logs/stream` | **`operation_logs`** |
| **顶栏健康** | `GET /health` | 无 |

---

### 7.1 健康检查

#### GET /health

| 项 | 内容 |
|----|------|
| **方法** | GET |
| **路径** | `/health` |
| **请求参数** | 无 |
| **响应 200** | `{ "status": "ok" }` |
| **错误码** | 无 |
| **实现** | `app.js` → 匿名 handler |
| **业务说明** | 前端顶栏连接状态探针 |

---

### 7.2 LLM 置信度问答

#### POST /ask/confidence

| 项 | 内容 |
|----|------|
| **方法** | POST |
| **路径** | `/ask/confidence` |
| **Body** | `{ "question": string, "kb_id": string, "top_k"?: number(1-20), "match_profile_id"?: string }` |
| **响应 200** | 见下方 JSON |
| **错误码** | 400 参数空；404 kb 不存在；502 LLM 错误 |
| **实现** | `app.js` → `runConfidenceMatch()` |
| **业务说明** | 同步一次性返回，无 SSE 中间日志 |

```json
{
  "question": "怎么安装吊带",
  "kb_id": "1",
  "match": {
    "raw_output": "[{\"id\":\"q003\",\"confidence\":0.92}]",
    "candidates": [{ "id": "q003", "confidence": 0.92, "question": "吊带安装方法" }]
  },
  "answer": "Top1 答案 Markdown",
  "answers": [{ "id": "q003", "confidence": 0.92, "question": "...", "answer": "..." }],
  "timings": { "total_ms": 1200, "prepare_ms": 5, "match_ms": 1100, "lookup_ms": 1, "tokens": {} },
  "cache_hit": true
}
```

#### POST /ask/confidence/stream

| 项 | 内容 |
|----|------|
| **方法** | POST |
| **路径** | `/ask/confidence/stream` |
| **Body** | 同 `/ask/confidence` |
| **响应** | `Content-Type: text/event-stream` |
| **SSE 事件** | `log` → `candidates` → `done` \| `error` |
| **错误码** | 400 JSON（启动前校验失败）；流内 `error` 事件 |
| **实现** | `app.js`；超时 `DEBUG_REQUEST_TIMEOUT_S` |
| **业务说明** | 调试页「提问」主路径 |

**SSE `log` 事件 data：**

```json
{ "line": "[step] ...", "kind": "step|log|match|cache|..." }
```

**SSE `candidates` 事件 data：**

```json
{
  "raw_output": "...",
  "candidates": [{ "id": "q003", "confidence": 0.92, "question": "..." }],
  "enabled_count": 42,
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }]
}
```

**SSE `done` 事件 data：** 同 POST `/ask/confidence` 响应体。

**SSE `error` 事件 data：**

```json
{ "detail": "错误信息", "timed_out": true }
```

---

### 7.3 LLM 知识库 `/knowledge-bases/*`

#### GET /knowledge-bases

| 项 | 内容 |
|----|------|
| **Body/Query** | 无 |
| **响应 200** | `{ "items": [{ "kb_id", "name", "status", "match_prompt", "enabled_count" }] }` |
| **实现** | `app.js` + `KbStore` + `QuestionsCache.getEnabledCount` |

#### POST /knowledge-bases

| 项 | 内容 |
|----|------|
| **Body** | `{ "kb_id"?: string, "name"?: string }` |
| **响应 200** | `{ "kb_id", "name", ... }` |
| **错误码** | 400 创建失败 |
| **副作用** | 创建磁盘目录、`cache.loadKb` |

#### GET /knowledge-bases/:kbId

| 项 | 内容 |
|----|------|
| **Path** | `kbId` |
| **响应 200** | 单库详情 + `enabled_count` |
| **错误码** | 404 |

#### DELETE /knowledge-bases/:kbId

| 项 | 内容 |
|----|------|
| **响应 200** | 被删库配置 |
| **副作用** | `cache.evictKb`、删除磁盘 `kb_{id}/` |
| **错误码** | 404 |

#### POST /knowledge-bases/:kbId/rename

| 项 | 内容 |
|----|------|
| **Body** | `{ "name": string }` |
| **错误码** | 400 |

#### GET /knowledge-bases/:kbId/confidence-prompt-preview

| 项 | 内容 |
|----|------|
| **Query** | `top_k`?(1-20) |
| **响应 200** | `{ "kb_id", "confidence_match_prompt", "system_prompt", "enabled_count" }` |

#### POST /knowledge-bases/:kbId/reload

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "kb_id", "loaded_at", "enabled_count" }` |
| **业务说明** | 从 PG 重载 FAQ 到内存索引 |

#### POST /knowledge-bases/:kbId/import/from-rag

| 项 | 内容 |
|----|------|
| **Body** | `{ "rag_kb_id": string, "append"?: boolean(default true), "replace"?: boolean }` |
| **响应 200** | `{ "ok": true, "imported": number, ... }` |
| **实现** | `importRagFaqToLlm()` |

#### GET /knowledge-bases/:kbId/questions

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "version": number, "items": QAItem[] }` |

#### PUT /knowledge-bases/:kbId/questions

| 项 | 内容 |
|----|------|
| **Body** | `{ "version": number, "items": QAItem[] }` |
| **响应 200** | 更新后完整文档 |
| **副作用** | `cache.reloadKb` |

#### POST /knowledge-bases/:kbId/questions/items

| 项 | 内容 |
|----|------|
| **Body** | `QAItem`（含 `id`） |
| **错误码** | 400 id 已存在 |

#### PUT /knowledge-bases/:kbId/questions/items/:itemId

| 项 | 内容 |
|----|------|
| **Body** | `QAItem`，`body.id` 必须等于路径 `itemId` |
| **错误码** | 404 item 不存在 |

#### DELETE /knowledge-bases/:kbId/questions/items/:itemId

| 项 | 内容 |
|----|------|
| **响应 200** | 被删 `QAItem` |

#### GET /knowledge-bases/:kbId/recall-tests

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "items": RecallTestRow[] }` |

#### PUT /knowledge-bases/:kbId/recall-tests

| 项 | 内容 |
|----|------|
| **Body** | 召回度文档 JSON |
| **响应 200** | 保存后文档 |

#### POST /knowledge-bases/:kbId/import/generate-questions

| 项 | 内容 |
|----|------|
| **Body** | `{ "answer_md": string }` |
| **响应 200** | `{ "question", "variants": string[], "tokens": TokenUsage }` |
| **错误码** | 502 LLM 错误 |
| **实现** | `generateFaqQuestionsOnly` + `import` 槽位模型 |

#### POST /knowledge-bases/:kbId/import/commit

| 项 | 内容 |
|----|------|
| **Body** | `{ "items": QAItem[], "targets": ["llm"|"rag"], "append"?: bool, "rag_kb_id"?: string, "auto_rebuild_rag"?: bool(default true) }` |
| **响应 200** | `{ "llm": number, "rag": number, "kb_id", "items": QAItem[] }` |
| **副作用** | `syncAnswerAssetsToKb`、可选 `rebuildIndex` |

---

### 7.4 静态资源预览

#### GET /preview-asset

| 项 | 内容 |
|----|------|
| **Query** | `kb_id`（必填）, `ref`（assets 相对路径） |
| **响应 200** | 二进制文件（sendFile） |
| **错误码** | 400 非法 ref/路径穿越；404 不存在 |
| **实现** | `kbAssetsDirPath(filesRoot, kbId)` |

#### GET /documents/preview-asset

| 项 | 内容 |
|----|------|
| **Query** | `ref` |
| **响应 200** | 图片文件 |
| **查找顺序** | `documents/assets/` → 各 `kb_*/assets/` → 各 `rag_kb_*/assets/` |
| **业务说明** | 文档 Markdown 与 FAQ 预览共用 |

#### GET /documents/preview-file

| 项 | 内容 |
|----|------|
| **Query** | `path`（sources 下相对路径） |
| **响应 200** | `Content-Type: application/pdf` |
| **业务说明** | PDF 源文件内联预览 |

---

### 7.5 文档与 Markdown `/markdown-files/*` `/documents/*`

#### GET /markdown-files/tree

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "tree": FileTreeNode[] }` |
| **实现** | `buildMarkdownFilesTree()` |

#### GET /documents/capabilities

| 项 | 内容 |
|----|------|
| **响应 200** | 支持的源类型与 `capabilities` 说明 |
| **实现** | `listCapabilitiesPayload()` |

#### GET /documents/excel-sheets

| 项 | 内容 |
|----|------|
| **Query** | `filename` |
| **响应 200** | `{ "sheets": string[] }` |
| **错误码** | 404 源文件不存在 |

#### GET /markdown-files/content

| 项 | 内容 |
|----|------|
| **Query** | `path` |
| **响应 200** | `{ "path", "kind", "markdown", "editable", "line_count", ... }` |

#### PUT /markdown-files/content

| 项 | 内容 |
|----|------|
| **Body** | `{ "path": string, "markdown": string }` |

#### DELETE /markdown-files

| 项 | 内容 |
|----|------|
| **Query** | `path` |

#### PUT /markdown-files/rename

| 项 | 内容 |
|----|------|
| **Body** | `{ "path", "name" }` |
| **响应 200** | `{ "path", "name" }` |

#### POST /markdown-files

| 项 | 内容 |
|----|------|
| **Body** | `{ "name", "markdown"?: "" }` |
| **响应 200** | `{ "path", "kind" }` |

#### POST /documents/upload

| 项 | 内容 |
|----|------|
| **Content-Type** | `multipart/form-data`，字段 `file` |
| **Query/Body** | `overwrite=1|true` 可选 |
| **响应 200** | `{ "filename", "size", "file_type", "kind", "capabilities", "line_count"? }` |
| **错误码** | 400 无文件/类型不支持；409 已存在且未 overwrite |

#### POST /documents/extract/stream

| 项 | 内容 |
|----|------|
| **Body** | `{ "filename", "ranges": [[start,end],...], "sheet_name"?, "use_vlm_refine"?: bool(default true) }` |
| **响应** | SSE：`log` → `done` \| `error` |
| **done data** | `{ "path", "markdown"?, "stats", "warnings"? }` |
| **实现** | `fileProcessor.*` + keepalive comment 每 8s |

---

### 7.6 日志 `/logs/*`

#### GET /logs

| 项 | 内容 |
|----|------|
| **Query** | `limit`(default 500), `modules`/`module`, `kb_id`, `level` |
| **响应 200** | `{ "items": LogEntry[] }` |

#### GET /logs/stream

| 项 | 内容 |
|----|------|
| **Query** | `since`（ISO ts 游标） |
| **响应** | SSE，每秒轮询，事件 `log`，data 为 `LogEntry` |

---

### 7.7 设置 `/settings/*`

#### GET /settings/prompts

| 项 | 内容 |
|----|------|
| **Query** | `kb_id?`（预览用） |
| **响应 200** | 提示词字段 + `defaults` + `confidence_system_preview` + `enabled_count` |

#### PUT /settings/prompts

| 项 | 内容 |
|----|------|
| **Body** | 可选 `confidence_match_prompt`, `faq_generation_prompt`, `pdf_vlm_prompt` |

#### GET /settings/match-profiles

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "default_id", "profiles": MatchProfile[] }` |

#### PUT /settings/match-profiles

| 项 | 内容 |
|----|------|
| **Body** | profile 文档 JSON |

#### GET /settings/models

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "slots": { "import": {...}, "pdf_vlm": {...} } }` |

#### PUT /settings/models

| 项 | 内容 |
|----|------|
| **Body** | `{ "slots": {...} }` 或直接 slots 对象 |

#### GET /settings/rag-models

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "slots": { "embedding", "rerank", "llm" } }` |
| **实现** | `ragRoutes.js` |

#### PUT /settings/rag-models

| 项 | 内容 |
|----|------|
| **Body** | `{ "slots": {...} }` |

#### GET /settings/rag-prompts

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "embedding_prompt", "rerank_prompt", "llm_prompt", "defaults", "llm_system_preview" }` |

#### PUT /settings/rag-prompts

| 项 | 内容 |
|----|------|
| **Body** | 可选三个 prompt 字段 |

---

### 7.8 RAG `/rag/*`

#### GET /rag/health

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "ok": true, "weaviate": {...}, "indexes": { [kbId]: indexStatus } }` |
| **错误码** | 503 Weaviate/索引异常 |

#### GET /rag/knowledge-bases

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "items": [{ "kb_id", "name", "enabled_count" }] }` |

#### POST /rag/knowledge-bases

| 项 | 内容 |
|----|------|
| **Body** | `{ "kb_id"?, "name"（必填） }` |
| **副作用** | `ensureRagKbStructure` 创建磁盘目录 |

#### DELETE /rag/knowledge-bases/:kbId

| 项 | 内容 |
|----|------|
| **副作用** | 删磁盘、`weaviateStore.deleteByKbId` |

#### POST /rag/knowledge-bases/:kbId/rename

| 项 | 内容 |
|----|------|
| **Body** | `{ "name" }` |

#### POST /rag/knowledge-bases/:ragKbId/import/from-llm

| 项 | 内容 |
|----|------|
| **Body** | `{ "llm_kb_id", "append"?, "replace"?, "auto_rebuild"?: bool(default true) }` |
| **响应 200** | `{ "ok", "imported", "meta"?: rebuild 结果 }` |

#### GET /rag/knowledge-bases/:kbId/runtime-config

| 项 | 内容 |
|----|------|
| **响应 200** | `RagRuntimeConfig`（见 types.ts） |

#### PUT /rag/knowledge-bases/:kbId/runtime-config

| 项 | 内容 |
|----|------|
| **Body** | 部分或完整 runtime 字段 |

#### GET/PUT /rag/knowledge-bases/:kbId/questions

| 项 | 内容 |
|----|------|
| **说明** | 与 LLM 库 questions API 相同结构；PUT 不自动 reload LLM cache |

#### POST/PUT/DELETE /rag/knowledge-bases/:kbId/questions/items[...]

| 项 | 内容 |
|----|------|
| **说明** | 同 LLM items CRUD；变更会 `markIndexStale` |

#### POST /rag/knowledge-bases/:kbId/index/rebuild

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "ok": true, "meta": { "items", "search_docs", "embedding_model", "built_at", ... } }` |
| **错误码** | 500 |
| **实现** | `rebuildIndex(kbId, ragCtx)` |

#### GET /rag/knowledge-bases/:kbId/index/status

| 项 | 内容 |
|----|------|
| **响应 200** | `{ "ready": bool, "reason"?, "built_at"?, ... }` |

#### GET /rag/search

#### POST /rag/search

| 项 | 内容 |
|----|------|
| **Query/Body** | `query`/`q`, `kb_id`, `top_k`?(1-50) |
| **响应 200** | `{ "query", "results": RagSearchResult[], "timing", "tokens", "token_breakdown" }` |
| **错误码** | 409 索引未就绪 |
| **实现** | `RagRetriever.search()` |

#### POST /rag/chat

| 项 | 内容 |
|----|------|
| **Body** | `{ "query", "kb_id", "top_n"?, "use_llm_answer"? }` |
| **响应 200** | `RagChatResponse`（含 `answer`, `confidence`, `mode`, `sources`, `timing`） |
| **错误码** | 409 索引未就绪；500 内部错误 |
| **实现** | `RagRetriever.chat()` |

#### GET/PUT /rag/knowledge-bases/:kbId/recall-tests

| 项 | 内容 |
|----|------|
| **说明** | RAG 召回度测试集，结构同 LLM recall-tests |

---

## 8. SSE 流式协议

### 8.1 帧格式

```
event: {eventName}
data: {JSON}

```

- 事件边界：双换行 `\n\n`。
- `data` 必须为单行 JSON（服务端 `JSON.stringify`）。
- 部分端点首包发送 `: connected\n\n` 或 `: keepalive\n\n`（comment，客户端忽略）。

### 8.2 使用 SSE 的端点

| 端点 | 事件类型 | 顺序 |
|------|----------|------|
| `POST /ask/confidence/stream` | `log`, `candidates`, `done`, `error` | log 可多条 → candidates → done |
| `POST /documents/extract/stream` | `log`, `done`, `error` | log(step) 多条 → done |
| `GET /logs/stream` | `log` | 持续推送新 LogEntry |

### 8.3 响应头

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### 8.4 前端解析

`api/client.ts` → `consumeSseStream()`：

1. `ReadableStream` 增量读取 + `TextDecoder`
2. 按 `\n\n` 切块 → `parseSseBlock`
3. `error` 且 `timed_out: true` → 抛 `AskTimeoutError`

---

## 9. 图片 assets 路径约定

### 9.1 Markdown 引用格式

```markdown
![说明](assets/screenshot.png)
```

- 相对路径统一为 **`assets/{filename}`**（无前导 `./` 或 `../`）。
- HTTP(S) 与 `data:` URL 原样保留，不参与 sync。

### 9.2 物理存储位置

| 场景 | 目录 |
|------|------|
| 文档提取 | `files/documents/assets/` |
| LLM FAQ 答案 | `files/kb_{id}/assets/` |
| RAG FAQ 答案 | `files/rag_kb_{id}/assets/` |

### 9.3 HTTP 预览 URL

| 场景 | URL |
|------|-----|
| LLM 库 FAQ 预览 | `/preview-asset?kb_id={id}&ref=assets/xxx.png` |
| 文档/通用预览 | `/documents/preview-asset?ref=assets/xxx.png` |

### 9.4 导入时同步

`POST .../import/commit` 调用 `syncAnswerAssetsToKb`：

1. `collectAssetRefsFromText(answer)` 收集引用
2. 在 documents、各 kb_*/rag_kb_* 的 assets 中查找源文件
3. 复制到目标库 `assets/`（已存在则跳过）

---

## 10. 环境变量

配置文件：`Router/.env`（参见 `.env.example`）。

### 10.1 必填

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接串，如 `postgresql://user:pass@127.0.0.1:5432/router` |

### 10.2 服务

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8002` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_ROOT` | `APP_ROOT` | 数据根 |
| `FILES_ROOT` | `{DATA_ROOT}/files` | 业务文件根 |
| `DEBUG_REQUEST_TIMEOUT_S` | `60`（example 写 180） | 流式问答服务端超时 |
| `SKIP_JSON_SEED` | — | 设 `1` 跳过首次 JSON→PG |

### 10.3 LLM API

| 变量 | 默认 | 说明 |
|------|------|------|
| `API_BASE_URL` | OpenAI URL | 全局默认 API |
| `API_KEY` / `ARK_API_KEY` | — | API 密钥 |
| `MATCH_MODEL` | `gpt-4.1-mini` | 默认匹配模型 |
| `IMPORT_MODEL` | 同 MATCH | FAQ 生成模型 |
| `MAX_TOKENS` | `4096` | 通用 max tokens |
| `MATCH_MAX_TOKENS` | `8` | 匹配输出（旧） |
| `CONFIDENCE_MAX_TOKENS` | `512` | 置信度匹配输出 |
| `CONFIDENCE_TOP_K` | `5` | 默认 Top K |
| `MATCH_TEMPERATURE` | `0` | 匹配温度 |
| `DISABLE_THINKING` | `1` | 全局关闭思考链 |
| `ENABLE_THINKING` | — | 显式 1/0 覆盖 |
| `MOCK_LLM` | `0` | 本地 mock LLM |
| `USE_MAX_COMPLETION_TOKENS` | `0` | 云厂商兼容 |
| `USE_CONTENT_PARTS` | `0` | 多模态 content parts |

### 10.4 RAG / Weaviate

| 变量 | 默认 | 说明 |
|------|------|------|
| `WEAVIATE_URL` | — | Weaviate HTTP 地址 |
| `WEAVIATE_API_KEY` | — | API Key |
| `WEAVIATE_CLASS` | `FaqSearchDoc` | Class 名 |
| `MOCK_WEAVIATE` | `0` | 内存 mock |
| `RAG_EMBEDDING_MODEL` | `BAAI/bge-m3` | Embedding 模型 |
| `RAG_RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | Rerank 模型 |
| `RAG_LLM_MODEL` | `Qwen/Qwen3-VL-8B-Instruct` | RAG 合成 LLM |
| `SILICONFLOW_BASE_URL` | siliconflow.cn | Embedding/Rerank API |
| `RAG_VECTOR_TOP_K` | `30` | 向量检索候选数 |
| `RAG_KEYWORD_TOP_K` | `30` | 关键词候选数 |
| `RAG_RRF_K` | `60` | RRF 常数 k |
| `DISABLE_API_EMBEDDING` | `0` | 1=使用 hash embedding |
| `HASH_EMBEDDING_DIM` | `1024` | 本地 hash 维度 |
| `EMBEDDING_BATCH_SIZE` | `16` | 批大小 |
| `EMBEDDING_SLEEP_SEC` | `0.25` | 批间 sleep |
| `EMBEDDING_MAX_CHARS` | `6000` | 单条截断 |

### 10.5 数据库连接池

| 变量 | 默认 |
|------|------|
| `DATABASE_POOL_SIZE` | `20` |
| `TEST_DATABASE_URL` | 测试用 |

---

## 11. 开发与部署命令

### 11.1 首次环境准备

```bash
cd Router
cp .env.example .env
# 编辑 .env 填入 DATABASE_URL、API_KEY 等

# 创建 PostgreSQL 数据库（可选脚本）
npm run db:setup -w server

# 迁移 + seed
npm run db:migrate -w server
npm run db:seed -w server
```

### 11.2 开发模式

```bash
# monorepo 根：同时启动 server(:8002) + client(Vite :5173 代理到 8002)
npm run dev

# 仅后端（--watch 热重载）
npm run dev -w server

# 仅前端
npm run dev -w client
```

### 11.3 生产构建与启动

```bash
npm run build          # 构建 client → client/dist
npm run start          # node server/src/index.js，托管 dist + API
```

### 11.4 测试

```bash
npm run test           # server vitest
npm run test:watch -w server
```

### 11.5 其他 server 脚本

| 命令 | 说明 |
|------|------|
| `npm run db:migrate -w server` | 执行 SQL 迁移 |
| `npm run db:seed -w server` | JSON 导入 PG |
| `npm run export-faq-answers -w server` | 导出 FAQ 答案 Markdown |
| `npm run copy-llm-recall-to-rag -w server` | 复制 LLM 召回测试到 RAG |

### 11.6 Weaviate（可选）

```bash
docker compose -f docker-compose.weaviate.yml up -d
# .env 中配置 WEAVIATE_URL=http://localhost:8080
```

### 11.7 访问地址

| 环境 | URL |
|------|-----|
| 开发前端 | `http://localhost:5173`（API 代理到 8002） |
| 生产/后端直连 | `http://localhost:8002` |
| 开发者手册 | `http://localhost:8002/dev-manual.md` 或 public 静态路径 |

---

## 附录 A：QAItem 类型速查

```typescript
interface QAItem {
  id: string;           // q001
  question: string;     // 标准问
  variants: string[];   // 变体问
  answer: string;       // Markdown 答案
  enabled: boolean;     // 是否启用
  updated_at?: string;
}
```

## 附录 B：相关源文件索引

| 主题 | 文件 |
|------|------|
| Express 主路由 | `server/src/app.js` |
| RAG 路由 | `server/src/routes/ragRoutes.js` |
| 启动入口 | `server/src/index.js` |
| 配置加载 | `server/src/config.js` |
| 路径常量 | `server/src/services/paths.js` |
| 前端根组件 | `client/src/App.tsx` |
| 类型定义 | `client/src/types.ts` |
| API 客户端 | `client/src/api/client.ts` |
| 文件管理主视图 | `client/src/views/ManageFilesView.tsx` |
| 文件网格 | `client/src/components/FileGridPanel.tsx`、`FileGridCard.tsx` |
| 文件侧栏/树工具 | `client/src/utils/importShared.tsx` |
| 文档类型与能力 | `client/src/utils/documentTypes.ts` |

---

*文档版本：与 Router monorepo 当前代码同步（含文件管理网格/预览双视图 UI）。修改 API 或 schema 时请同步更新本文档。*
