/** 三点操作菜单（竖排 ⋯） */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";

export function KebabMenu({
  children,
  className = "",
  align = "right",
}: {
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
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
    <div className={`kebabMenu ${className}`.trim()} ref={ref}>
      <button
        type="button"
        className="btn btnXs ghost kebabMenuBtn"
        aria-label="操作"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        ⋯
      </button>
      {panel.mounted && (
        <div
          className={`dropdownMenu kebabMenuPanel kebabMenuPanel--${align} ${panel.animClass}`}
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
