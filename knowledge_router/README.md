# knowledge_router

单层「知识库 + 标准问题 JSON」问答匹配系统。LLM 仅做语义匹配（极简输出 `id` 或 `NONE`），回答从内存中的预存 JSON 直接返回。

## 快速开始

```powershell
cd knowledge_router
copy .env.example .env
# 编辑 .env 填写 API_KEY

cd ..
.\start-knowledge-server.ps1
```

浏览器打开 http://localhost:8001

## 架构

- **系统提示词** = 匹配规则 + 全部标准问题列表（`id|question`）
- **用户消息** = 当前问题
- **模型输出** = `q001` 或 `NONE`（约 1–8 tokens）
- **代码** = O(1) 查内存返回 `answer`

FAQ JSON 启动时全量载入内存；管理页保存后自动 `reload_kb`。

## 配置

| 变量 | 说明 |
|------|------|
| `MATCH_MODEL` | 匹配模型 |
| `MATCH_MAX_TOKENS` | 匹配输出 token 上限（代码 clamp 至 ≥16 以兼容部分网关） |
| `MATCH_TEMPERATURE` | 建议 0 |
| `MOCK_LLM=1` | 本地 mock，无需 API |

## API 概览

- `POST /ask`、`POST /ask/stream` — 问答
- `GET/POST /knowledge-bases` — 知识库 CRUD
- `GET/PUT /knowledge-bases/{id}/questions` — FAQ JSON
- `GET /knowledge-bases/{id}/match-prompt-preview` — 完整 system prompt 预览

## 测试

```powershell
cd d:\agent-group
$env:MOCK_LLM="1"; $env:API_KEY="test"; $env:PYTHONPATH="d:\agent-group"
python -m pytest knowledge_router/tests/ -q
```

## 数据目录

```
knowledge_router/
  config/knowledge_bases.json
  files/kb_{id}/questions.json
  files/kb_{id}/assets/
```
