import type { ReactNode } from "react";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";

/** 按 visible 挂载/卸载并附加淡入淡出 class，用于模式切换、条件表单项等 */
export function FadePanel({
  show,
  children,
  className = "",
  durationMs,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
  durationMs?: number;
}) {
  const anim = useAnimatedVisible(show, durationMs);
  if (!anim.mounted) return null;
  const cls = [className, anim.animClass].filter(Boolean).join(" ");
  return <div className={cls}>{children}</div>;
}
