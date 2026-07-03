/**
 * client.ts — 前端 API 与通用工具层
 *
 * 职责：
 * 1. 封装 fetch：apiJson（REST JSON）、consumeSseStream（SSE 流解析）
 * 2. 业务级流式接口：streamAskConfidence（LLM 问答）、streamDocumentExtract（文档提取）
 * 3. 展示用工具：fmtMs、fmtConfidence、escapeHtml、FAQ id 格式化等
 *
 * 开发环境下请求经 Vite 代理到 Express :8002（见 client/vite.config.ts）；
 * 生产环境由同一端口静态托管，路径仍为相对根路径如 /ask/confidence/stream。
 */

import type { SseEvent } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// 超时常量与错误类型
// ─────────────────────────────────────────────────────────────────────────────

/** 调试问答（LLM 流式匹配）客户端超时：3 分钟，与 .env DEBUG_REQUEST_TIMEOUT_S 默认 180 对齐 */
export const DEBUG_ASK_TIMEOUT_MS = 180000;
export const DEBUG_ASK_TIMEOUT_S = DEBUG_ASK_TIMEOUT_MS / 1000; //转换为秒数，便于展示

// 问答请求超时错误类
export class AskTimeoutError extends Error {
  constructor(message = "超时") {
    super(message);
    this.name = "AskTimeoutError";
  }
}

export function isAskTimeoutError(err: unknown): boolean { //判断是否是超时错误
  return err instanceof AskTimeoutError || (err as Error)?.name === "AskTimeoutError";
}

// ─────────────────────────────────────────────────────────────────────────────
// 展示与格式化工具（多 View 共用）
// ─────────────────────────────────────────────────────────────────────────────

/** 将用户/API 文本转义为安全 HTML，防止 innerHTML 渲染时 XSS */
export function escapeHtml(s: string | null | undefined): string {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** 毫秒格式化为 UI 可读字符串 */
export function fmtMs(ms: number | undefined | null): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—"; // 无效值显示 "——"
  if (n < 1000) return `${Math.round(n)} ms`; // 小于1秒显示毫秒
  return `${(n / 1000).toFixed(2)} s`; // 大于1秒显示秒数，保留两位小数
}

/** 0–1 置信度转为百分比字符串，无效值显示 em dash */
export function fmtConfidence(n: number | undefined | null): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/** 合并两段 TokenUsage（如 RAG 多阶段 embedding + rerank + generate） */
export function sumTokenUsage(a?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }, b?: typeof a) {
  const x = a || {};
  const y = b || {};
  return {
    prompt_tokens: (x.prompt_tokens || 0) + (y.prompt_tokens || 0),
    completion_tokens: (x.completion_tokens || 0) + (y.completion_tokens || 0),
    total_tokens: (x.total_tokens || 0) + (y.total_tokens || 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE（Server-Sent Events）解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析单个 SSE 消息块（以空行 \n\n 分隔）。
 * 格式：event: xxx\ndata: {...}
 * 无 data 行时返回 null；data 按 JSON 解析为对象
 */
function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split("\n");
  let event = "message"; // 默认事件类型为消息
  let data = ""; // 默认数据为空字符串
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim(); // 如果行以 "event:" 开头，则提取事件类型
    else if (line.startsWith("data:")) data += line.slice(5).trim(); // 如果行以 "data:" 开头，则提取数据
  }
  if (!data) return null; // 如果数据为空，则返回 null
  return { event, data: JSON.parse(data) as Record<string, unknown> };
}

/**
 * 从 fetch Response 读取 body 流，按 SSE 协议切块并回调 onEvent。
 *
 * - 使用 ReadableStream + TextDecoder 增量解码
 * - 双换行 \n\n 为事件边界
 * - 可选 AbortSignal：abort 时抛 AskTimeoutError（与问答超时统一处理）
 * - 服务端 error 事件且 data.timed_out 时同样抛 AskTimeoutError
 *
 * 用于：/ask/confidence/stream、/documents/extract/stream
 */
export async function consumeSseStream(
  resp: Response,
  onEvent: (evt: SseEvent) => void,
  { signal }: { signal?: AbortSignal } = {},
) {
  const reader = resp.body!.getReader(); // 读取响应体流
  const decoder = new TextDecoder(); // 解码器
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new AskTimeoutError(); // 每次读前/后检查是否超时，如果超时，则抛出超时错误
      const { done, value } = await reader.read(); 
      if (signal?.aborted) throw new AskTimeoutError();
      if (value) buffer += decoder.decode(value, { stream: true }); // 将读取到的值解码并添加到缓冲区
      let sep: number;
      // 缓冲区中每凑齐一个完整 SSE 块就解析一次
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep); // 提取完整 SSE 块
        buffer = buffer.slice(sep + 2); // 更新缓冲区
        const evt = parseSseBlock(block); // 解析 SSE 块
        if (evt) {
          if (evt.event === "error" && evt.data?.timed_out) // 如果事件类型为 error 且 data.timed_out 为 true，则抛出超时错误
            throw new AskTimeoutError(String(evt.data.detail || "超时"));
          onEvent(evt); // 调用回调函数，传入解析后的事件
        }
      }
      if (done) { // 如果流结束，但缓冲区可能还有未以 \n\n 结尾的最后一块
        if (buffer.trim()) {
          const evt = parseSseBlock(buffer); // 解析最后一块
          if (evt) {
            if (evt.event === "error" && evt.data?.timed_out) 
              throw new AskTimeoutError(String(evt.data.detail || "超时"));
            onEvent(evt); 
          }
        }
        break;
      }
    }
  } finally { // 释放资源
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

// REST JSON 封装

/**
 * 通用 JSON API 请求。
 *
 * - 网络失败：提示检查 8002 端口
 * - 响应体优先 JSON.parse；非 JSON 且 ok 时返回原始文本
 * - !ok 时优先抛 data.detail（FastAPI/Express 风格），否则 statusText
 *
 * 全项目大部分 GET/PUT/POST 均通过此函数调用
 */
export async function apiJson<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, options); 
  } catch {
    throw new Error("无法连接服务器，请确认 Router 服务已启动（端口 8002）");
  }
  const txt = await r.text(); // 将响应体转换为文本
  let data: T | null = null;
  try {
    data = JSON.parse(txt) as T; // 将文本解析为 JSON
  } catch {
    if (!r.ok) throw new Error(txt || r.statusText);
    return txt as T;
  }
  if (!r.ok) throw new Error((data as { detail?: string })?.detail || txt || r.statusText);
  return data as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// 业务级流式 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LLM 置信度匹配流式问答。
 * POST /ask/confidence/stream
 *
 * body 典型字段：question, kb_id, top_k, match_profile_id
 * SSE 事件：log（步骤日志）→ candidates（候选列表）→ done（最终答案与 timings）
 *
 * 客户端 AbortController 在 DEBUG_ASK_TIMEOUT_MS 后 abort，统一转为 AskTimeoutError
 */
export async function streamAskConfidence(
  body: Record<string, unknown>,
  onEvent: (evt: SseEvent) => void,
) {
  const controller = new AbortController(); // 创建 AbortController 实例
  const timeoutId = setTimeout(() => controller.abort(), DEBUG_ASK_TIMEOUT_MS); // 设置超时时间
  try {
    let resp: Response; // 响应体
    try {
      resp = await fetch("/ask/confidence/stream", { // 发送请求
        method: "POST",
        headers: { "Content-Type": "application/json" }, // 设置请求头
        body: JSON.stringify(body), // 设置请求体
        signal: controller.signal, // 设置信号
      });
    } catch (e) {
      if (controller.signal.aborted || (e as Error)?.name === "AbortError") throw new AskTimeoutError(); // 如果信号被中止，则抛出超时错误
      throw new Error("无法连接服务器，请确认服务已启动"); // 如果无法连接服务器，则抛出错误
    }
    if (!resp.ok) throw new Error(await resp.text()); // 如果响应体不是 OK，则抛出错误
    await consumeSseStream(resp, onEvent, { signal: controller.signal }); // 消费 SSE 流
  } catch (e) {
    if (controller.signal.aborted || (e as Error)?.name === "AbortError") throw new AskTimeoutError(); // 如果信号被中止，则抛出超时错误
    throw e;
  } finally {
    clearTimeout(timeoutId); // 清除超时定时器
  }
}

/**
 * 文档提取流式任务（PDF/Word/Excel 等转 Markdown）。
 * POST /documents/extract/stream
 *
 * body 典型字段：filename, ranges, use_vlm_refine, sheet_name
 * SSE 事件：log（kind=step 为步骤）→ done（path、stats）或 error
 *
 * 无客户端超时（提取可能很久）；Vite 对该路径配置了 proxyTimeout: 0
 */
export async function streamDocumentExtract(
  body: Record<string, unknown>,
  onEvent: (evt: SseEvent) => void,
) {
  const resp = await fetch("/documents/extract/stream", { // 发送请求
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, // 设置请求头
    body: JSON.stringify(body), // 设置请求体
  });
  if (!resp.ok) throw new Error(await resp.text()); // 如果响应体不是 OK，则抛出错误
  await consumeSseStream(resp, onEvent); // 消费 SSE 流
}

/** 从 SSE log 事件 data 中取展示文本（兼容 line / message / detail 字段名） */
export function sseLogText(data: Record<string, unknown>): string {
  const line = data.line ?? data.message ?? data.detail; // 获取日志文本
  return line != null ? stripAnsi(String(line).trim()) : ""; // 如果日志文本不为空，则去除 ANSI 颜色码和 \r，并返回
}

/** 提取进度面板：只展示 kind=step 的步骤行，过滤普通 log */
export function sseStepText(data: Record<string, unknown>): string {
  if (data.kind && data.kind !== "step") return ""; // 如果 kind 不为 step，则返回空字符串
  return sseLogText(data); // 获取日志文本
}

/** 去掉终端 ANSI 颜色码与 \r，避免进度区出现乱码 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, ""); // 去除 ANSI 颜色码和 \r
}

/** 数字序号 → FAQ id，如 1 → q001（与后端 assignQuestionIds 一致） */
export function formatQuestionId(n: number): string {
  return `q${String(n).padStart(3, "0")}`; // 将数字转换为字符串，并补齐为3位，如 1 → q001
}

/** FAQ id → 数字序号，无法解析时返回 0 */
export function parseQuestionNum(id: string): number {
  const m = /^q(\d+)$/i.exec(id || ""); // 如果 id 以 q 开头，则提取数字
  return m ? parseInt(m[1], 10) : 0; // 如果提取到数字，则转换为数字，否则返回 0
}

/** 召回度测试行是否已标注（yes/no）；空字符串表示尚未跑批 */
export function isRecallLabeled(row: { recalled?: string }): boolean {
  return row.recalled === "yes" || row.recalled === "no";
}
