import { useCallback, useMemo, useRef } from "react";

/** Markdown 源代码编辑器 */
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

  /** 同步滚动 */
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const gutter = gutterRef.current;
    if (ta && gutter)
      gutter.scrollTop = ta.scrollTop;
  }, []);

  /** 处理变化 */
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(e.target.value);
  };

  /** 如果不需要显示行号，则显示文本框 */
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

  /** 如果需要显示行号，则显示代码编辑器 */
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
