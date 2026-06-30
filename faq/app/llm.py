from __future__ import annotations

import json
from typing import Any

import requests

from .config import Settings, settings
from .text_utils import clip_text, strip_markdown


class ModelClient:
    def __init__(self, cfg: Settings = settings):
        self.cfg = cfg

    @property
    def enabled(self) -> bool:
        return self.cfg.has_api_key

    def rerank(self, query: str, documents: list[str], top_n: int) -> list[tuple[int, float]]:
        if not documents:
            return []
        if not (self.enabled and self.cfg.use_rerank):
            return [(i, 1.0 / (i + 1)) for i in range(min(top_n, len(documents)))]
        try:
            resp = requests.post(
                f"{self.cfg.siliconflow_base_url}/rerank",
                headers=self._headers(),
                json={
                    "model": self.cfg.rerank_model,
                    "query": query,
                    "documents": documents,
                    "top_n": min(top_n, len(documents)),
                    "return_documents": False,
                },
                timeout=120,
            )
            resp.raise_for_status()
            ranked = []
            for item in resp.json().get("results") or []:
                ranked.append((int(item["index"]), float(item.get("relevance_score", 0.0))))
            return ranked or [(i, 1.0 / (i + 1)) for i in range(min(top_n, len(documents)))]
        except Exception as exc:
            print(f"[rerank] rerank skipped: {exc}", flush=True)
            return [(i, 1.0 / (i + 1)) for i in range(min(top_n, len(documents)))]

    def generate_answer(self, query: str, sources: list[dict], runtime=None) -> str:
        if not (self.enabled and self.cfg.use_llm_answer):
            return sources[0]["answer"] if sources else "未找到高置信答案。"
        context = "\n\n".join(
            f"[来源 {i + 1}] 主问题：{src['question']}\n答案全文：{strip_markdown(src['answer'])}"
            for i, src in enumerate(sources)
        )
        if runtime is not None:
            template = runtime.active_template().get("content", "{query}\n\n{context}")
            temperature = float(runtime.temperature)
        else:
            template = (
                "你是相机 FAQ 助手。请综合给定的一条或多条 FAQ 来源回答用户问题，不能编造；"
                "如果资料不足，请说明未找到高置信答案。回答使用简体中文。\n\n"
                "用户问题：{query}\n\nFAQ 来源（每条含主问题与完整答案）：\n{context}"
            )
            temperature = 0.1
        try:
            prompt = template.format(query=query, context=context)
        except Exception:
            prompt = f"{template}\n\n用户问题：{query}\n\nFAQ 来源：\n{context}"
        try:
            resp = requests.post(
                f"{self.cfg.siliconflow_base_url}/chat/completions",
                headers=self._headers(),
                json={
                    "model": self.cfg.llm_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "max_tokens": 1200,
                },
                timeout=180,
            )
            resp.raise_for_status()
            choices = resp.json().get("choices") or []
            if choices:
                return (choices[0].get("message") or {}).get("content") or ""
        except Exception as exc:
            print(f"[llm] generation skipped: {exc}", flush=True)
        return sources[0]["answer"] if sources else "未找到高置信答案。"

    def judge(self, query: str, expected_answer: str, actual_answer: str, sources: list[dict]) -> dict[str, Any]:
        fallback = self._fallback_judge(expected_answer, actual_answer)
        if not self.enabled:
            return fallback
        source_text = "\n".join(
            f"- {src.get('id')}: {src.get('question')}" for src in sources[:5]
        )
        prompt = (
            "你是 RAG 评测裁判。请比较标准答案和系统答案，输出严格 JSON，不要输出额外文本。\n"
            "JSON 字段：quality_score, confidence, groundedness, image_support, reason。\n"
            "所有分数范围 0 到 1。\n\n"
            f"用户问题：{query}\n\n标准答案：{clip_text(strip_markdown(expected_answer), 1800)}\n\n"
            f"系统答案：{clip_text(strip_markdown(actual_answer), 1800)}\n\n检索来源：\n{source_text}"
        )
        try:
            resp = requests.post(
                f"{self.cfg.siliconflow_base_url}/chat/completions",
                headers=self._headers(),
                json={
                    "model": self.cfg.judge_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0,
                    "max_tokens": 500,
                },
                timeout=180,
            )
            resp.raise_for_status()
            content = ((resp.json().get("choices") or [{}])[0].get("message") or {}).get("content") or "{}"
            start = content.find("{")
            end = content.rfind("}")
            parsed = json.loads(content[start : end + 1] if start >= 0 and end >= start else content)
            return {**fallback, **parsed}
        except Exception as exc:
            fallback["judge_error"] = str(exc)
            return fallback

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.cfg.siliconflow_api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _fallback_judge(expected_answer: str, actual_answer: str) -> dict[str, Any]:
        exp = set(strip_markdown(expected_answer))
        act = set(strip_markdown(actual_answer))
        overlap = len(exp & act) / max(1, len(exp))
        score = max(0.0, min(1.0, overlap))
        return {
            "quality_score": score,
            "confidence": score,
            "groundedness": score,
            "image_support": 0.0,
            "reason": "本地降级评估：按答案字符覆盖率粗略估计。",
            "judge_error": "",
        }
