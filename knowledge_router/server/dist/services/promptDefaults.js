import { defaultConfidenceMatchPrompt } from "./matcher.js";
export const DEFAULT_PDF_VLM_PROMPT_ZH = `你是文档版面还原助手。将 PDF 页面图像转为 Markdown，保留标题层级、列表、表格结构。
图片引用使用相对路径 assets/文件名.png。不要省略表格内容。`;
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
