import { defaultConfidenceMatchPrompt } from "./matcher.js";
export const DEFAULT_PDF_VLM_PROMPT_ZH = `你是文档版面还原助手。将 PDF 页面图像转为 Markdown，保留标题层级、列表、表格结构。
图片引用使用相对路径 assets/文件名.png。不要省略表格内容。`;
export const DEFAULT_DOC_REFINE_PROMPT_ZH = `你是文档 Markdown 整理助手。输入为从 Word/Excel/HTML 等自动转换的初稿及配图。
请在不删改事实的前提下：修正标题层级、列表与表格结构、规范图片引用（保持 assets/ 相对路径）、去除多余空行与乱码。
只输出整理后的 Markdown 正文，不要代码块包裹，不要解释。`;
export const DEFAULT_FAQ_QUESTIONS_PROMPT_ZH = `你是 FAQ 知识库生成器。根据给定的 Markdown 回答正文，生成标准问题与用户问法变体。

要求：
1. question：一句标准用户问法，像真实用户会问的话，不要只抄标题。
2. variants：1 到 3 条口语/模糊其他问法，互不重复。
3. 不要修改或输出 answer，只生成问法。

输出严格 JSON，不要 Markdown 代码块：

{
  "question": "标准问题？",
  "variants": ["变体1", "变体2"]
}`;
export function allDefaultPrompts(topK = 5) {
    return {
        confidence_match_prompt: defaultConfidenceMatchPrompt(topK),
        faq_generation_prompt: DEFAULT_FAQ_QUESTIONS_PROMPT_ZH,
        pdf_vlm_prompt: DEFAULT_PDF_VLM_PROMPT_ZH,
    };
}
