import type { ReactNode } from "react";
import { ModeSwitch, type AskMode } from "./ModeSwitch";

export function ModeBar({
  label = "问答模式",
  mode,
  onChange,
  children,
}: {
  label?: string;
  mode: AskMode;
  onChange: (m: AskMode) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="modeBar">
        <span className="modeBarLabel">{label}</span>
        {children ?? <ModeSwitch mode={mode} onChange={onChange} />}
      </div>
      <div className="modeBarDivider" aria-hidden="true" />
    </>
  );
}
