import { useCallback, useMemo, useRef } from "react";

export function MdSourceEditor({
  id,
  value,
  onChange,
  placeholder,
  showLineNumbers = false,
  className = "",
  readOnly = false,
}: {
  id?: string;
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  showLineNumbers?: boolean;
  className?: string;
  readOnly?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n"), [value]);
  const lineCount = Math.max(lines.length, 1);

  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const gutter = gutterRef.current;
    if (ta && gutter)
      gutter.scrollTop = ta.scrollTop;
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(e.target.value);
  };

  if (!showLineNumbers) {
    return (
      <textarea
        id={id}
        ref={textareaRef}
        className={`mdSourceTextarea ${className}`.trim()}
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        readOnly={readOnly}
        onChange={readOnly ? undefined : handleChange}
      />
    );
  }

  return (
    <div className={`mdSourceEditor ${className}`.trim()}>
      <div ref={gutterRef} className="mdSourceGutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i + 1} className="mdSourceLineNo">{i + 1}</div>
        ))}
      </div>
      <textarea
        id={id}
        ref={textareaRef}
        className="mdSourceTextarea mdSourceTextareaWithGutter"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        readOnly={readOnly}
        onChange={readOnly ? undefined : handleChange}
        onScroll={syncScroll}
      />
    </div>
  );
}
