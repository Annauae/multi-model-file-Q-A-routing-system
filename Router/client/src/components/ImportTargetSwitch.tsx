export function ImportTargetSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="importTargetSwitch">
      <span className="importTargetLabel">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggleSwitch${checked ? " on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggleThumb" />
      </button>
    </label>
  );
}
