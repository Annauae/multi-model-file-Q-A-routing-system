"""内置默认提示词（设置页展示与恢复默认）。"""
from __future__ import annotations

from .matcher import default_confidence_match_prompt
from .questions_import import DEFAULT_FAQ_QUESTIONS_PROMPT_ZH

DEFAULT_PDF_VLM_PROMPT_ZH = """你是技术手册 Markdown 整理助手（路线B：Docling 粗提取 + VLM 按 PDF 还原布局）。

你会收到：
1. 多页 PDF 渲染图（按页码顺序，第 1 张图对应第 1 页，以此类推）
2. 已合并的 Docling 粗提取 Markdown（含 <!-- page N --> 分页标记）
3. 全部已提取图片的相对路径列表（assets/...）

任务：对照各页 PDF 渲染图，修正整段 Markdown，使其尽量还原原 PDF 的标题层级、段落顺序、列表/表格与插图位置。

规则：
- 以 Docling 粗稿为正文基础，对照 PDF 修正结构与排版；不要编造 PDF 中不存在的内容
- 图片引用必须使用提供的 assets/ 相对路径，禁止绝对路径；可调整图片在正文中的位置以贴近 PDF
- 保留编号符号（①②）、表格、引用块等原有语义
- 一定不要保留 <!-- page N --> 分页标记
- 若某页插图未在正文中引用，可在该页末尾用「## 本页插图」集中列出
- 不要保留 PDF 页眉页脚、角标、书中页码（如「章节名 + 单独数字行」、`<p align="center">154</p>` 等）
- 只输出完整多页 Markdown 正文：不要用代码块包裹整个输出，不要添加解释性前言
"""


def default_confidence_match_prompt_text(*, top_k: int = 5) -> str:
    return default_confidence_match_prompt(top_k=top_k)


def default_faq_generation_prompt_text() -> str:
    return DEFAULT_FAQ_QUESTIONS_PROMPT_ZH


def default_pdf_vlm_prompt_text() -> str:
    return DEFAULT_PDF_VLM_PROMPT_ZH.strip()


def all_default_prompts(*, top_k: int = 5) -> dict[str, str]:
    return {
        "confidence_match_prompt": default_confidence_match_prompt_text(top_k=top_k),
        "faq_generation_prompt": default_faq_generation_prompt_text(),
        "pdf_vlm_prompt": default_pdf_vlm_prompt_text(),
    }
