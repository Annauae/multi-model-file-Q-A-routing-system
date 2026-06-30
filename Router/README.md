# Router — React + Express 知识问答控制台

与 [`knowledge_router`](../knowledge_router)（Python FastAPI + vanilla JS）功能对等的 Node.js 版本。

- **前端**：React 18 + TypeScript + Vite
- **后端**：Express（[`server/src/`](server/src/)）
- **默认端口**：8002（Python 版为 8001）
- **数据**：独立目录 `config/`、`files/`（首次从 Python 版复制）

## 快速开始

```powershell
# 1. 初始化数据（一次性，从 knowledge_router 复制）
.\scripts\init-data.ps1

# 2. 安装依赖
cd Router
npm install

# 3. 配置环境
copy .env.example .env
# 编辑 .env 填写 API_KEY（或使用 MOCK_LLM=1 本地调试）

# 4. 开发模式（Express :8002 + Vite :5173）
npm run dev

# 5. 生产模式
npm run build
npm start
```

浏览器：
- 开发：http://localhost:5173（API 代理到 8002）
- 生产：http://localhost:8002

## 目录结构

```
Router/
├── client/          # React 前端
├── server/          # Express 后端
├── config/          # 知识库配置（init-data 生成）
├── files/           # FAQ 与文档数据
├── logs/            # 操作日志
└── scripts/         # 初始化脚本
```

## 测试

```powershell
cd Router
npm test
```

使用 `MOCK_LLM=1` 运行 vitest，覆盖 health、knowledge-bases、ask/confidence 等核心 API。

## 与 Python 版差异

| 项目 | Python 版 | Router 版 |
|------|-----------|-----------|
| 端口 | 8001 | 8002 |
| 数据 | `knowledge_router/config` | `Router/config`（独立副本） |
| 召回度批量运行 | `isRecallLabeled` 未定义 bug | 已修复 |

## PDF 提取

PDF 转 Markdown 仍依赖 monorepo 内 `model_router/scripts/docling_extract_pages.py` 及 Python 环境。
