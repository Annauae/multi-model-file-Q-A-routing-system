import { useEffect, useState } from "react";
import { apiJson } from "../api/client";

export function IndexStatusPill({ kbId, onRebuild }: { kbId: string; onRebuild?: () => void }) {
  const [status, setStatus] = useState<{ ready?: boolean; stale?: boolean; reason?: string } | null>(null);

  const load = async () => {
    if (!kbId) { setStatus(null); return; }
    try {
      const data = await apiJson<{ ready: boolean; stale: boolean; reason?: string }>(
        `/rag/knowledge-bases/${encodeURIComponent(kbId)}/index/status`,
      );
      setStatus(data);
    } catch {
      setStatus({ ready: false, stale: true, reason: "未知" });
    }
  };

  useEffect(() => { void load(); }, [kbId]);

  if (!kbId) return null;
  const cls = !status?.ready ? "missing" : status.stale ? "stale" : "ready";
  const text = !status?.ready ? "未构建索引" : status.stale ? "索引过期" : "索引就绪";

  return (
    <span className="indexStatusWrap">
      <span className={`pill indexStatusPill ${cls}`}>{text}</span>
      {onRebuild && (
        <button type="button" className="btn btnXs ghost" onClick={() => void (async () => {
          await apiJson(`/rag/knowledge-bases/${encodeURIComponent(kbId)}/index/rebuild`, { method: "POST" });
          await load();
          onRebuild();
        })()}>
          重建索引
        </button>
      )}
    </span>
  );
}
