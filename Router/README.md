# Router — React + Express 知识问答控制台

与 [`knowledge_router`](../knowledge_router)（Python FastAPI + vanilla JS）功能对等的 Node.js 版本。

- **前端**：React 18 + TypeScript + Vite
- **后端**：Express + **PostgreSQL**（[`server/src/`](server/src/)）
- **默认端口**：8002（Python 版为 8001）
- **结构化数据**：PostgreSQL（知识库、FAQ、配置、日志、召回测试、RAG 元数据）
- **文件数据**：`files/` 文档 Markdown、上传源文件、图片 assets（保留在磁盘）

## 快速开始

```powershell
# 1. （可选）从 knowledge_router 复制 files/ 文档数据
.\scripts\init-data.ps1

# 2. 安装依赖
cd Router
npm install

# 3. PostgreSQL：创建库并写入 .env
#    需本机已安装 PostgreSQL 16+，并设置 postgres 用户密码
$env:PGPASSWORD="你的密码"
npm run db:setup -w server

# 4. 配置 API（若 .env 尚无 API_KEY）
#    编辑 .env 填写 API_KEY，或使用 MOCK_LLM=1 本地调试

# 5. 开发模式（Express :8002 + Vite :5173）
npm run dev

# 6. 生产模式
npm run build
npm start
```

浏览器：
- 开发：http://localhost:5173（API 代理到 8002）
- 生产：http://localhost:8002

## 数据库

| 命令 | 说明 |
|------|------|
| `npm run db:setup -w server` | 创建 `router` 库并写入 `DATABASE_URL` |
| `npm run db:migrate -w server` | 执行 SQL 迁移（启动时自动执行） |
| `npm run db:seed -w server` | 兼容命令：若存在遗留 JSON 则导入 PG，否则无操作 |

环境变量见 [`.env.example`](.env.example)：`DATABASE_URL`、`DATABASE_POOL_SIZE`。

结构化数据（知识库、FAQ、模型配置、召回测试、日志等）**仅存 PostgreSQL**；`files/` 仅保留文档 Markdown、上传源文件与图片 assets。

## 目录结构

```
Router/
├── client/          # React 前端
├── server/          # Express 后端 + db/ 数据层 + pdf_extract/（PDF Python 脚本）
├── config/          # 预留目录（配置已存 PostgreSQL）
├── files/           # 文档与附件
├── logs/            # 预留目录（日志已存 PostgreSQL）
└── scripts/         # 初始化脚本
```

## 测试

```powershell
cd Router
# 需配置 .env 中 DATABASE_URL（可与开发库相同）
npm test
```

使用 `MOCK_LLM=1`、`MOCK_WEAVIATE=1` 运行 vitest；测试前会 `TRUNCATE` 相关表并种子数据。

## 文档

| 文档 | 路径 | 说明 |
|------|------|------|
| 使用指南 | [`client/public/manual.md`](client/public/manual.md) | 面向业务用户；应用内「使用手册 → 使用指南」 |
| 开发者文档 | [`client/public/dev-manual.md`](client/public/dev-manual.md) | 架构、API、前后端实现；应用内「开发者文档」 |

开发模式下通过 Vite 访问 `/static/manual.md`；生产构建后由 Express 静态托管。

## 与 Python 版差异

| 项目 | Python 版 | Router 版 |
|------|-----------|-----------|
| 端口 | 8001 | 8002 |
| 结构化存储 | JSON 文件 | PostgreSQL |
| 文档/附件 | 文件系统 | 文件系统（不变） |
| 召回度批量运行 | `isRecallLabeled` 未定义 bug | 已修复 |

## PDF 提取

PDF 转 Markdown 使用内置 Python 脚本（`server/pdf_extract/`），需本机安装 Python 3.10+ 及依赖：

```powershell
pip install -r server/pdf_extract/requirements.txt
```

脚本读取 `Router/.env` 中的 `API_KEY`、`API_BASE_URL` 等；VLM 模型由设置页「pdf_vlm」槽位或 `--model` 参数指定。
