import { useEffect, useState } from "react";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";

type SlotDraft = {
  api_base_url?: string;
  api_key?: string;
  model?: string;
  enable_thinking?: boolean | null;
  max_tokens?: number;
  temperature?: number;
};

function KeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [masked, setMasked] = useState(true);
  const realKey = value || "";
  return (
    <span className="keyInputWrap">
      <input
        className={`modelModalInput keyInput${masked && realKey ? " keyMasked" : ""}`}
        type="text"
        value={masked && realKey ? "..." : realKey}
        placeholder="可留空（Ollama 无需 Key）"
        autoComplete="off"
        readOnly={masked && !!realKey}
        onChange={(e) => { if (!masked || !realKey) onChange(e.target.value); }}
        onFocus={() => { if (masked && realKey) setMasked(false); }}
      />
      <button type="button" className="keyToggleBtn" onClick={() => setMasked(!masked)} aria-label={masked ? "显示" : "隐藏"}>
        {masked ? "👁" : "🙈"}
      </button>
    </span>
  );
}

export function SlotConfigModal({
  open,
  title,
  description,
  slot,
  showThinking = true,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  description?: string;
  slot: SlotDraft;
  showThinking?: boolean;
  onClose: () => void;
  onSave: (slot: SlotDraft) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<SlotDraft>(slot);
  const anim = useAnimatedVisible(open);

  useEffect(() => {
    if (open) setDraft({ ...slot });
  }, [open, slot]);

  if (!anim.mounted) return null;

  const update = (field: keyof SlotDraft, value: string | number | boolean | null) => {
    setDraft({ ...draft, [field]: value });
  };

  return (
    <div className={`modelModalOverlay ${anim.animClass}`} onClick={onClose}>
      <div className={`modelModal ${anim.animClass}`} onClick={(e) => e.stopPropagation()}>
        <div className="modelModalHead">
          <h3>{title}</h3>
          <button type="button" className="modelModalClose" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modelModalBody">
          {description && <p className="muted settingsSectionDesc">{description}</p>}
          <label className="modelModalField">
            <span>接口地址</span>
            <input className="modelModalInput" value={draft.api_base_url || ""} onChange={(e) => update("api_base_url", e.target.value)} />
          </label>
          <label className="modelModalField">
            <span>API Key</span>
            <KeyInput value={draft.api_key || ""} onChange={(v) => update("api_key", v)} />
          </label>
          <label className="modelModalField">
            <span>模型名称</span>
            <input className="modelModalInput" value={draft.model || ""} onChange={(e) => update("model", e.target.value)} />
          </label>
          {showThinking && (
            <label className="modelModalField">
              <span>思考模式</span>
              <select className="modelModalInput" value={draft.enable_thinking === true ? "true" : draft.enable_thinking === false ? "false" : ""} onChange={(e) => {
                const v = e.target.value;
                update("enable_thinking", v === "" ? null : v === "true");
              }}>
                <option value="">默认</option>
                <option value="false">关闭（Ollama 本地推荐）</option>
                <option value="true">开启</option>
              </select>
            </label>
          )}
          <label className="modelModalField">
            <span>Max Tokens</span>
            <input className="modelModalInput" type="number" value={draft.max_tokens ?? 4096} onChange={(e) => update("max_tokens", parseInt(e.target.value, 10))} />
          </label>
          <label className="modelModalField">
            <span>Temperature</span>
            <input className="modelModalInput" type="number" step={0.1} value={draft.temperature ?? 0} onChange={(e) => update("temperature", parseFloat(e.target.value))} />
          </label>
        </div>
        <div className="modelModalFoot">
          <span />
          <button type="button" className="btn primary modelModalSave" onClick={() => void (async () => { await onSave(draft); onClose(); })()}>保存</button>
        </div>
      </div>
    </div>
  );
}
