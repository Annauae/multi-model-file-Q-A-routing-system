import { useEffect, useState } from "react";
import { apiJson } from "../api/client";
import { useAppUi } from "../context/AppUiContext";

export function IndexStatusPill({ kbId, onRebuild }: { kbId: string; onRebuild?: () => void }) {
  const { showToast } = useAppUi();
  const [status, setStatus] = useState<{ ready?: boolean; stale?: boolean; reason?: string } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

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
        <button type="button" className="btn btnXs ghost" disabled={rebuilding} onClick={() => void (async () => {
          setRebuilding(true);
          try {
            await apiJson(`/rag/knowledge-bases/${encodeURIComponent(kbId)}/index/rebuild`, { method: "POST" });
            showToast("索引重建成功");
            await load();
            onRebuild();
          } catch (e) {
            showToast((e as Error).message, "error");
          } finally {
            setRebuilding(false);
          }
        })()}>
          {rebuilding ? "重建中…" : "重建索引"}
        </button>
      )}
    </span>
  );
}
