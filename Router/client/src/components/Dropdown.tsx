/** 下拉菜单 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";

export function Dropdown({ label, children, primary = true }: { label: string; children: ReactNode; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useAnimatedVisible(open);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className={`btn btnXs ${primary ? "primary" : "ghost"} dropdownToggle`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        {label}<span className="dropdownChevron">▾</span>
      </button>
      {panel.mounted && (
        <div
          className={`dropdownMenu ${panel.animClass}`}
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
