import { useEffect, useState } from "react";
import type { MatchProfile } from "../types";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";

function KeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [masked, setMasked] = useState(true);
  const realKey = value || "";
  return (
    <span className="keyInputWrap">
      <input
        className={`modelModalInput keyInput${masked && realKey ? " keyMasked" : ""}`}
        type="text"
        value={masked && realKey ? "..." : realKey}
        placeholder="输入你的 API Key"
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

export function ProfileConfigModal({
  open,
  profile,
  isDefault,
  isNew = false,
  canDelete = true,
  onClose,
  onSave,
  onDelete,
  onSetDefault,
}: {
  open: boolean;
  profile: MatchProfile | null;
  isDefault: boolean;
  isNew?: boolean;
  canDelete?: boolean;
  onClose: () => void;
  onSave: (profile: MatchProfile) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onSetDefault?: () => void;
}) {
  const [draft, setDraft] = useState<MatchProfile | null>(profile);
  const anim = useAnimatedVisible(open);

  useEffect(() => {
    if (open) setDraft(profile ? { ...profile } : null);
  }, [open, profile]);

  if (!anim.mounted || !draft) return null;

  const update = (field: keyof MatchProfile, value: string | number | boolean | null) => {
    setDraft({ ...draft, [field]: value });
  };

  const handleSave = async () => {
    await onSave({
      ...draft,
      name: draft.name || draft.model || "新模型",
      id: draft.id || `p_${Date.now()}`,
    });
    onClose();
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <div className={`modelModalOverlay ${anim.animClass}`} onClick={handleClose}>
      <div className={`modelModal ${anim.animClass}`} onClick={(e) => e.stopPropagation()}>
        <div className="modelModalHead">
          <h3>{isNew ? "添加自定义模型" : "模型配置"}</h3>
          <button type="button" className="modelModalClose" onClick={handleClose} aria-label="关闭">✕</button>
        </div>
        <div className="modelModalBody">
          <label className="modelModalField">
            <span>显示名称</span>
            <input className="modelModalInput" value={draft.name || ""} onChange={(e) => update("name", e.target.value)} placeholder="例如：Ollama qwen3:8b" />
          </label>
          <label className="modelModalField">
            <span>接口地址</span>
            <input className="modelModalInput" value={draft.api_base_url || ""} onChange={(e) => update("api_base_url", e.target.value)} placeholder="云端或本机 Ollama 地址" />
          </label>
          <label className="modelModalField">
            <span>API Key</span>
            <KeyInput value={draft.api_key || ""} onChange={(v) => update("api_key", v)} />
          </label>
          <label className="modelModalField">
            <span>模型名称</span>
            <input className="modelModalInput" value={draft.model || ""} onChange={(e) => update("model", e.target.value)} placeholder="输入模型名称" />
          </label>
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
          <label className="modelModalField">
            <span>Max Tokens</span>
            <input className="modelModalInput" type="number" value={draft.max_tokens ?? 4096} onChange={(e) => update("max_tokens", parseInt(e.target.value, 10))} />
          </label>
          <label className="modelModalField">
            <span>Temperature</span>
            <input className="modelModalInput" type="number" step={0.1} value={draft.temperature ?? 0} onChange={(e) => update("temperature", parseFloat(e.target.value))} />
          </label>
          {!isNew && onSetDefault && (
            <label className="modelModalCheck">
              <input type="radio" checked={isDefault} onChange={onSetDefault} /> 设为默认问答模型
            </label>
          )}
        </div>
        <div className="modelModalFoot">
          <div className="modelModalFootLeft">
            {!isNew && canDelete && onDelete && (
              <button type="button" className="btn btnXs ghost danger" onClick={() => void onDelete?.()}>删除</button>
            )}
            <p className="modelModalNote muted">自定义配置，请遵守法规并关注模型规则和 token 消耗</p>
          </div>
          <button type="button" className="btn primary modelModalSave" onClick={() => void handleSave()}>保存</button>
        </div>
      </div>
    </div>
  );
}
