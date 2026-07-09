import { useEffect, useRef, useState } from "react";
import { FadePanel } from "./FadePanel";
import { IndexStatusPill } from "./IndexStatusPill";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";
import type { AskMode } from "../types";

type KbMap = Record<string, { name?: string }>;

export function AskConfigPopover({
  mode,
  onModeChange,
  kbIds,
  kbMap,
  kbValue,
  onKbChange,
  profiles = [],
  profileValue = "",
  onProfileChange,
  topK,
  onTopKChange,
  indexKbId,
}: {
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
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panel = useAnimatedVisible(open);
  const profileName = profiles.find((p) => p.id === profileValue)?.name || profileValue || "默认";
  const kbName = kbMap[kbValue]?.name || kbValue || "知识库";
  const pillLabel = mode === "llm" ? `${profileName} · Top${topK}` : `RAG · Top${topK}`;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="askConfigWrap" ref={wrapRef}>
      <button type="button" className="askConfigPill" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="askConfigPillIcon" aria-hidden>⚙</span>
        <span className="askConfigPillText">{pillLabel}</span>
        <span className="askConfigChevron" aria-hidden>▾</span>
      </button>
      {panel.mounted && (
        <div className={`askConfigDropdown ${panel.animClass}`}>
          <div className="askConfigRow">
            <span className="askConfigRowLabel">问答模式</span>
            <div className="askModeToggle">
              <button type="button" className={`askModeOpt${mode === "llm" ? " active" : ""}`} onClick={() => onModeChange("llm")}>LLM 匹配</button>
              <button type="button" className={`askModeOpt${mode === "rag" ? " active" : ""}`} onClick={() => onModeChange("rag")}>RAG 检索</button>
            </div>
          </div>
          <div className="askConfigDivider" />
          <FadePanel show key={`kb-${mode}`} className="askConfigField modePanelEnter">
            <span className="askConfigFieldLabel">知识库</span>
            <select className="askConfigSelect" value={kbValue} onChange={(e) => onKbChange(e.target.value)}>
              {kbIds.map((id) => <option key={id} value={id}>{kbMap[id]?.name || id}</option>)}
            </select>
          </FadePanel>
          <FadePanel show={mode === "llm" && !!onProfileChange} className="askConfigField modePanelEnter">
            <span className="askConfigFieldLabel">问答模型</span>
            <select className="askConfigSelect" value={profileValue} onChange={(e) => onProfileChange?.(e.target.value)}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
          </FadePanel>
          <div className="askConfigField">
            <span className="askConfigFieldLabel">Top K</span>
            <input
              type="number"
              className="askConfigInput"
              min={1}
              max={20}
              value={topK}
              onChange={(e) => onTopKChange(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 5)))}
            />
          </div>
          <FadePanel show={mode === "rag" && !!indexKbId} className="askConfigRow askConfigIndexRow modePanelEnter">
            <span className="askConfigRowLabel">索引状态</span>
            {indexKbId && <IndexStatusPill kbId={indexKbId} />}
          </FadePanel>
          <FadePanel show key={`hint-${mode}`} className="askConfigHint muted modePanelEnter">
            {kbName}
          </FadePanel>
        </div>
      )}
    </div>
  );
}
