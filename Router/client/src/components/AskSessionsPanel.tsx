import type { AskSession } from "../hooks/useAskSessions";

export function AskSessionsPanel({
  sessions,
  activeSessionId,
  onSelect,
  onNewChat,
  onCollapse,
}: {
  sessions: AskSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  onCollapse: () => void;
}) {
  return (
    <aside className="askHistoryAside panel ui-fade-in">
      <div className="stripHead askHistoryHead">
        <div className="askHistoryHeadLeft">
          <button
            type="button"
            className="askHistoryCollapseBtn"
            onClick={onCollapse}
            aria-label="隐藏记录"
            title="隐藏记录"
          >
            ◀
          </button>
          <span>记录</span>
        </div>
        <button type="button" className="btn btnXs ghost askHistoryNewBtn" onClick={onNewChat}>
          新对话
        </button>
      </div>
      <div className="askHistoryBody scrollInner">
        <div className="askHistoryGroupLabel muted">近 7 天</div>
        {!sessions.length && <div className="empty">暂无会话</div>}
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`askHistoryItem${activeSessionId === session.id ? " active" : ""}`}
            onClick={() => onSelect(session.id)}
            title={session.title}
          >
            <span className="askHistoryQ">{session.title}</span>
            <span className="askHistoryMeta muted">{session.turns.length} 轮</span>
          </button>
        ))}
      </div>
      <div className="askHistoryFoot muted">按会话保存，最近 7 天</div>
    </aside>
  );
}

export function AskSessionsExpandBtn({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      type="button"
      className="askHistoryExpandBtn ui-fade-in"
      onClick={onExpand}
      aria-label="显示记录"
      title="显示记录"
    >
      ▶
    </button>
  );
}
