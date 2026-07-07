/** 下拉菜单 */
import { useState, useRef, useEffect, type ReactNode } from "react";

export function Dropdown({ label, children, primary = true }: { label: string; children: ReactNode; primary?: boolean }) {
  /** 是否打开 */
  const [open, setOpen] = useState(false);
  /** 引用 */
  const ref = useRef<HTMLDivElement>(null);

  /** 监听文档点击 */
  useEffect(() => {
    const onDoc = () => setOpen(false);
    document.addEventListener("click", onDoc); // 添加点击事件
    return () => document.removeEventListener("click", onDoc); // 移除点击事件
  }, []);

  return ( // 返回下拉菜单
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className={`btn btnXs ${primary ? "primary" : "ghost"} dropdownToggle`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        {label}<span className="dropdownChevron">▾</span>
      </button>
      <div className={`dropdownMenu ${open ? "" : "hidden"}`} onClick={(e) => { e.stopPropagation(); setOpen(false); }}>{children}</div>
    </div>
  );
}
