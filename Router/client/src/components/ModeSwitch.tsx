/**
 * ModeSwitch — LLM / RAG 双模式分段切换控件
 *
 * 职责：提供「问答模型」与「RAG」两个互斥选项的可点击切换 UI（iOS 风格 segmented control）。
 * 纯受控组件：不持有内部 state，当前选中项完全由父组件的 mode 决定。
 *
 * 使用位置：
 * - 默认由 ModeBar 渲染
 * - SettingsView 在自定义 children 中单独引用（与「保存全部」按钮并排）
 *
 * 关联类型 AskMode 在 types.ts 中也有同名导出，页面 state 通常引用 types 中的定义。
 */

/** 问答模式枚举：llm = 直连问答模型匹配，rag = 检索增强生成 */
export type AskMode = "llm" | "rag";

/**
 * 分段切换按钮组。
 *
 * @param mode     当前激活模式，决定哪个按钮带 .active 样式
 * @param onChange 点击按钮时通知父组件更新 mode
 */
export function ModeSwitch({ mode, onChange }: { mode: AskMode; onChange: (m: AskMode) => void }) {
  return (
    <div className="segmentedControl modeSwitch" role="group" aria-label="问答模式">
      <button
        type="button"
        className={`segmentedBtn ${mode === "llm" ? "active" : ""}`} // 如果当前模式为 "llm"，则按钮带 .active 样式
        onClick={() => onChange("llm")} // 点击问答模型按钮时，调用 onChange 函数，传入 "llm"
      >
        问答模型
      </button>
      <button
        type="button"
        className={`segmentedBtn ${mode === "rag" ? "active" : ""}`} // 如果当前模式为 "rag"，则按钮带 .active 样式
        onClick={() => onChange("rag")} // 点击 RAG 按钮时，调用 onChange 函数，传入 "rag"
      >
        RAG
      </button>
    </div>
  );
}
