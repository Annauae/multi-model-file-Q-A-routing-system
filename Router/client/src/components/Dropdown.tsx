import { useState, useRef, useEffect, type ReactNode } from "react";

export function Dropdown({ label, children, primary = true }: { label: string; children: ReactNode; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = () => setOpen(false);
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
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
      <div className={`dropdownMenu ${open ? "" : "hidden"}`} onClick={() => setOpen(false)}>{children}</div>
    </div>
  );
}
