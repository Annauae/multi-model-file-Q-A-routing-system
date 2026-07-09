export type AnswerNavItem = {
  id: string;
  label?: string;
  sub?: string;
  cardId: string;
};

export type AnswerNavGroup = {
  turnId: string;
  question: string;
  items: AnswerNavItem[];
};

export function GroupedAnswerNavPanel({
  title = "候选条目",
  groups,
  activeCardId,
  onSelect,
  emptyText = "—",
}: {
  title?: string;
  groups: AnswerNavGroup[];
  activeCardId?: string;
  onSelect: (cardId: string) => void;
  emptyText?: string;
}) {
  const hasItems = groups.some((g) => g.items.length > 0);
  return (
    <aside className="askNavAside panel ui-fade-in">
      <div className="stripHead"><span>{title}</span></div>
      <div className="askNavBody scrollInner">
        {!hasItems && <div className="empty">{emptyText}</div>}
        {groups.map((group) => (
          <div key={group.turnId} className="askNavGroup">
            <div className="askNavGroupTitle" title={group.question}>{group.question}</div>
            {group.items.map((item, i) => (
              <button
                key={`${item.cardId}-${i}`}
                type="button"
                className={`navItemBtn${activeCardId === item.cardId ? " active" : ""}`}
                onClick={() => onSelect(item.cardId)}
              >
                <span className="id">#{i + 1} {item.id}</span>
                <span className="muted">{item.label || item.sub || ""}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
