/**
 * ModeBar — 页面顶部的「模式切换」横条
 *
 * 职责：统一各页面（调试、管理、设置、召回测试等）的 LLM / RAG 模式切换区域布局：
 * 左侧标签 + 右侧控件，下方分隔线。默认右侧为 ModeSwitch；也可通过 children 自定义右侧内容。
 *
 * 典型用法：
 * - 默认：<ModeBar mode={mode} onChange={setMode} />
 * - 自定义右侧（如设置页「保存全部」按钮）：<ModeBar ...>{自定义节点}</ModeBar>
 */

import type { ReactNode } from "react";
import { ModeSwitch, type AskMode } from "./ModeSwitch";

/**
 * 模式切换横条组件。
 *
 * @param label   左侧说明文字，默认「问答模式」
 * @param mode    当前模式："llm"（问答模型）| "rag"（RAG）
 * @param onChange 模式变更回调；各页面通常在回调里重置相关本地状态
 * @param children 可选，替换默认的 ModeSwitch（见 SettingsView 的保存按钮组合）
 */
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
      {/* 主横条：flex 两端对齐，label 左、控件右 */}
      <div className="modeBar">
        <span className="modeBarLabel">{label}</span>
        {/* 未传 children 时渲染内置 ModeSwitch；传了则完全由调用方控制右侧 */}
        {children ?? <ModeSwitch mode={mode} onChange={onChange} />}
      </div>
      {/* 底部分隔线，aria-hidden 避免读屏重复播报装饰性元素 */}
      <div className="modeBarDivider" aria-hidden="true" />
    </>
  );
}
