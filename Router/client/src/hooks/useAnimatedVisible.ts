import { useEffect, useState } from "react";

/** 控制元素挂载/卸载时的淡入淡出 class */
export function useAnimatedVisible(visible: boolean, durationMs = 220) {
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, durationMs);
    return () => window.clearTimeout(t);
  }, [visible, mounted, durationMs]);

  const animClass = closing ? "ui-fade-out" : "ui-fade-in";
  return { mounted, closing, animClass };
}
