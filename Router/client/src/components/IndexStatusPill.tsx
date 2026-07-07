import { useEffect, useState } from "react";
import { apiJson } from "../api/client";
import { useAppUi } from "../context/AppUiContext";

/**
 * IndexStatusPill — RAG 模式下显示索引状态（就绪/过期/未构建）
 * 挂载于 App.tsx 调试页，kbId 变化时 GET /rag/knowledge-bases/:id/index/status
 */
export function IndexStatusPill({ kbId, onRebuild }: { kbId: string; onRebuild?: () => void }) {
  const { showToast } = useAppUi();
  const [status, setStatus] = useState<{ ready?: boolean; stale?: boolean; reason?: string } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  /** 加载索引状态 */
  const load = async () => {
    if (!kbId) { setStatus(null); return; } // 如果未选择知识库，则设置状态为 null
    try {
      const data = await apiJson<{ ready: boolean; stale: boolean; reason?: string }>(
        `/rag/knowledge-bases/${encodeURIComponent(kbId)}/index/status`,
      ); // 获取索引状态
      setStatus(data);
    } catch {
      setStatus({ ready: false, stale: true, reason: "未知" }); // 设置状态为未知
    }
  };

  useEffect(() => { void load(); }, [kbId]); // 监听知识库变化

  if (!kbId) return null; // 如果未选择知识库，则返回 null
  const cls = !status?.ready ? "missing" : status.stale ? "stale" : "ready"; // 设置状态类
  const text = !status?.ready ? "未构建索引" : status.stale ? "索引过期" : "索引就绪"; // 设置状态文本

  return ( // 返回索引状态
    <span className="indexStatusWrap">
      <span className={`pill indexStatusPill ${cls}`}>{text}</span>
      {onRebuild && ( // 如果需要重建，则显示重建按钮
        <button type="button" className="btn btnXs ghost" disabled={rebuilding} onClick={() => void (async () => {
          setRebuilding(true);
          try {
            await apiJson(`/rag/knowledge-bases/${encodeURIComponent(kbId)}/index/rebuild`, { method: "POST" }); // 重建索引
            showToast("索引重建成功");
            await load(); // 加载索引状态
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
