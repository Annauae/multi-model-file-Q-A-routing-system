import { useEffect, useState } from "react";
import { useAnimatedVisible } from "../hooks/useAnimatedVisible";

export function PromptConfigModal({
  open,
  title,
  description,
  label,
  value,
  preview,
  defaultValue,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  value: string;
  preview?: string;
  defaultValue?: string;
  onClose: () => void;
  onSave: (value: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const anim = useAnimatedVisible(open);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  if (!anim.mounted) return null;

  return (
    <div className={`modelModalOverlay ${anim.animClass}`} onClick={onClose}>
      <div className={`modelModal modelModalWide ${anim.animClass}`} onClick={(e) => e.stopPropagation()}>
        <div className="modelModalHead">
          <h3>{title}</h3>
          <button type="button" className="modelModalClose" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modelModalBody">
          {description && <p className="muted settingsSectionDesc">{description}</p>}
          {defaultValue != null && (
            <button type="button" className="btn btnXs ghost" onClick={() => setDraft(defaultValue)}>恢复默认提示词</button>
          )}
          <label className="modelModalField">
            <span>{label}</span>
            <textarea className="settingsTextarea modelModalTextarea" rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </label>
          {preview != null && (
            <label className="modelModalField">
              <span>规则预览（只读）</span>
              <textarea className="settingsTextarea readonly modelModalTextarea" rows={8} readOnly value={preview} />
            </label>
          )}
        </div>
        <div className="modelModalFoot">
          <span />
          <button type="button" className="btn primary modelModalSave" onClick={() => void (async () => { await onSave(draft); onClose(); })()}>保存</button>
        </div>
      </div>
    </div>
  );
}
