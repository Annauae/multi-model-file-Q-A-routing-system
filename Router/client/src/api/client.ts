import type { SseEvent } from "../types";

export const DEBUG_ASK_TIMEOUT_MS = 180000;
export const DEBUG_ASK_TIMEOUT_S = DEBUG_ASK_TIMEOUT_MS / 1000;

export class AskTimeoutError extends Error {
  constructor(message = "超时") {
    super(message);
    this.name = "AskTimeoutError";
  }
}

export function isAskTimeoutError(err: unknown): boolean {
  return err instanceof AskTimeoutError || (err as Error)?.name === "AskTimeoutError";
}

export function escapeHtml(s: string | null | undefined): string {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function fmtMs(ms: number | undefined | null): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function fmtConfidence(n: number | undefined | null): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function sumTokenUsage(a?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }, b?: typeof a) {
  const x = a || {};
  const y = b || {};
  return {
    prompt_tokens: (x.prompt_tokens || 0) + (y.prompt_tokens || 0),
    completion_tokens: (x.completion_tokens || 0) + (y.completion_tokens || 0),
    total_tokens: (x.total_tokens || 0) + (y.total_tokens || 0),
  };
}

function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { event, data: JSON.parse(data) as Record<string, unknown> };
}

export async function consumeSseStream(
  resp: Response,
  onEvent: (evt: SseEvent) => void,
  { signal }: { signal?: AbortSignal } = {},
) {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new AskTimeoutError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new AskTimeoutError();
      if (value) buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseSseBlock(block);
        if (evt) {
          if (evt.event === "error" && evt.data?.timed_out)
            throw new AskTimeoutError(String(evt.data.detail || "超时"));
          onEvent(evt);
        }
      }
      if (done) {
        if (buffer.trim()) {
          const evt = parseSseBlock(buffer);
          if (evt) {
            if (evt.event === "error" && evt.data?.timed_out)
              throw new AskTimeoutError(String(evt.data.detail || "超时"));
            onEvent(evt);
          }
        }
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

export async function apiJson<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, options);
  } catch {
    throw new Error("无法连接服务器，请确认 Router 服务已启动（端口 8002）");
  }
  const txt = await r.text();
  let data: T | null = null;
  try {
    data = JSON.parse(txt) as T;
  } catch {
    if (!r.ok) throw new Error(txt || r.statusText);
    return txt as T;
  }
  if (!r.ok) throw new Error((data as { detail?: string })?.detail || txt || r.statusText);
  return data as T;
}

export async function streamAskConfidence(
  body: Record<string, unknown>,
  onEvent: (evt: SseEvent) => void,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEBUG_ASK_TIMEOUT_MS);
  try {
    let resp: Response;
    try {
      resp = await fetch("/ask/confidence/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted || (e as Error)?.name === "AbortError") throw new AskTimeoutError();
      throw new Error("无法连接服务器，请确认服务已启动");
    }
    if (!resp.ok) throw new Error(await resp.text());
    await consumeSseStream(resp, onEvent, { signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted || (e as Error)?.name === "AbortError") throw new AskTimeoutError();
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function streamDocumentExtract(
  body: Record<string, unknown>,
  onEvent: (evt: SseEvent) => void,
) {
  const resp = await fetch("/documents/extract/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(await resp.text());
  await consumeSseStream(resp, onEvent);
}

export function formatQuestionId(n: number): string {
  return `q${String(n).padStart(3, "0")}`;
}

export function parseQuestionNum(id: string): number {
  const m = /^q(\d+)$/i.exec(id || "");
  return m ? parseInt(m[1], 10) : 0;
}

export function isRecallLabeled(row: { recalled?: string }): boolean {
  return row.recalled === "yes" || row.recalled === "no";
}
