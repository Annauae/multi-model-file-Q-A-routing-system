# FAQ 传统 RAG

本目录是一个独立的传统 RAG FAQ 项目，数据源为 `data/questions.json`。

## 功能

- FAQ 数据导入到 SQLite。
- 主问题、相似问法和答案摘要生成检索入口。
- FAISS 向量检索 + 中文关键词检索 + RRF 融合。
- 可选 SiliconFlow reranker 和 LLM/Judge。
- 问答页展示答案、来源、检索分数和图片证据。
- 批量评测页支持 10/50/100 条测试，输出 Recall@K、质量分、置信度和图片命中率。

## 运行

```powershell
cd D:\Arag\faq
pip install -r requirements.txt

# 如需云端 embedding/rerank/LLM，填写 .env 中的 SILICONFLOW_API_KEY
python scripts/build_index.py --rebuild
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

打开 `http://127.0.0.1:8000`。

## 图片资源

答案中的图片引用形如 `assets/knowledge_p28-30_001.png`，服务会从 `data/assets/` 暴露为 `/assets/...`。如果图片文件缺失，前端会显示缺图占位，并保留原始 `src`。

## API

- `GET /api/health`：索引和服务状态。
- `GET /api/search?q=...`：检索候选 FAQ。
- `POST /api/chat`：问答，默认 direct 返回高置信 Top-1 FAQ 原答案。
- `POST /api/eval/run`：创建批量评测任务。
- `GET /api/eval/runs/{run_id}`：查看评测进度和结果。
- `POST /api/index/rebuild`：重建索引。

## 评测说明

`holdout_variant` 模式会使用未写入索引的相似问法评测召回，能比 `indexed_variant` 更真实地反映泛化能力。LLM Judge 失败时会降级为本地粗略评分，不会中断整批评测。
