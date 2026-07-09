import { useEffect, useRef, useState } from "react";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";

export function SettingsModelDropdown({
  label,
  valueLabel,
  items,
  onPick,
  onAdd,
}: {
  label: string;
  valueLabel: string;
  items: { id: string; name: string; sub?: string }[];
  onPick: (id: string) => void;
  onAdd?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useAnimatedVisible(open);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="settingsGroupRow settingsRowWithDropdown" ref={ref}>
      <span className="settingsRowTitle">{label}</span>
      <button type="button" className="settingsRowSelect" onClick={() => setOpen((v) => !v)}>
        <span>{valueLabel}</span>
        <span className="settingsRowChevron">▾</span>
      </button>
      {panel.mounted && (
        <div className={`settingsDropdown ${panel.animClass}`}>
          <div className="settingsDropdownHead muted">内置模型</div>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="settingsDropdownItem"
              onClick={() => { setOpen(false); onPick(item.id); }}
            >
              <span>{item.name}</span>
              {item.sub && <span className="muted">{item.sub}</span>}
            </button>
          ))}
          {onAdd && (
            <button type="button" className="settingsDropdownAdd" onClick={() => { setOpen(false); onAdd(); }}>
              <span className="settingsAddIcon">+</span>
              <span>添加自定义模型</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function SettingsClickRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="settingsGroupRow settingsClickRow" onClick={onClick}>
      <span className="settingsRowTitle">{label}</span>
      <span className="settingsRowValue muted">{value || "点击配置"}</span>
      <span className="settingsRowChevron">›</span>
    </button>
  );
}
