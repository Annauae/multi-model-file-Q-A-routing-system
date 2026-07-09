import type { ReactNode } from "react";
import { AskConfigPopover } from "./AskConfigPopover";
import type { AskMode } from "../types";

type KbMap = Record<string, { name?: string }>;

export function AskComposer({
  question,
  onQuestionChange,
  onSubmit,
  onClear,
  onRandom,
  loading,
  mode,
  onModeChange,
  kbIds,
  kbMap,
  kbValue,
  onKbChange,
  profiles,
  profileValue,
  onProfileChange,
  topK,
  onTopKChange,
  indexKbId,
  extraActions,
  placeholder = "输入问题… Ctrl+Enter 提问",
  variant = "compact",
}: {
  question: string;
  onQuestionChange: (q: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  onRandom?: () => void;
  loading: boolean;
  mode: AskMode;
  onModeChange: (m: AskMode) => void;
  kbIds: string[];
  kbMap: KbMap;
  kbValue: string;
  onKbChange: (id: string) => void;
  profiles?: { id: string; name?: string }[];
  profileValue?: string;
  onProfileChange?: (id: string) => void;
  topK: number;
  onTopKChange: (n: number) => void;
  indexKbId?: string;
  extraActions?: ReactNode;
  placeholder?: string;
  variant?: "hero" | "compact";
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={`askComposer askComposer--${variant}`}>
      <textarea
        className="askComposerInput"
        rows={variant === "hero" ? 4 : 2}
        placeholder={placeholder}
        value={question}
        onChange={(e) => onQuestionChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="askComposerBar">
        <div className="askComposerLeft">
          <AskConfigPopover
            mode={mode}
            onModeChange={onModeChange}
            kbIds={kbIds}
            kbMap={kbMap}
            kbValue={kbValue}
            onKbChange={onKbChange}
            profiles={profiles}
            profileValue={profileValue}
            onProfileChange={onProfileChange}
            topK={topK}
            onTopKChange={onTopKChange}
            indexKbId={indexKbId}
          />
        </div>
        <div className="askComposerRight">
          {extraActions}
          {onRandom && (
            <button type="button" className="askIconBtn" title="随机问题" onClick={onRandom}>🎲</button>
          )}
          <button type="button" className="askIconBtn" title="清空" onClick={onClear}>✕</button>
          <button type="button" className="askSendBtn" disabled={loading} onClick={onSubmit} title="发送">
            {loading ? "…" : "➤"}
          </button>
        </div>
      </div>
      {variant === "compact" && <div className="askComposerFoot muted">内容由 AI 生成仅供参考</div>}
    </div>
  );
}
