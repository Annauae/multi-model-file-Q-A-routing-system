# Knowledge Router

单层 FAQ 知识问答匹配系统：用户提问 → LLM 语义匹配标准问题 → 从内存返回预存 JSON 回答。

## 快速开始

```powershell
cd knowledge_router
copy .env.example .env
# 也可直接复制 model_router/.env（字段相同；匹配模型默认用 ROUTER_MODEL）

cd ..
.\start-knowledge-server.ps1
```

浏览器打开 http://localhost:8001

## 架构要点

- **无双层 agent**：仅「知识库 + 标准问题 JSON」
- **仅匹配模型** `MATCH_MODEL`：不做回答生成
- **内存缓存**：启动时 `load_all()`，`/ask` 热路径不读盘
- **写时刷新**：管理 API 保存后自动 `reload_kb`

## 数据目录

```
config/knowledge_bases.json   # 知识库元数据
files/kb_{id}/questions.json  # FAQ 条目（标准问题 + 变体 + 预存回答）
files/kb_{id}/assets/         # 回答内引用的图片
```

## 主要 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/ask` | 同步问答 |
| POST | `/ask/stream` | SSE 流式（log / match / done） |
| GET/POST | `/knowledge-bases` | 知识库列表 / 创建 |
| GET/PUT | `/knowledge-bases/{id}/questions` | 读取 / 整文件保存 JSON |
| PUT | `/knowledge-bases/{id}/questions/items/{item_id}` | 更新单条 |
| PUT | `/knowledge-bases/{id}/prompt` | 匹配提示词 |

## 测试

```bash
cd knowledge_router
pytest tests/ -q
```
