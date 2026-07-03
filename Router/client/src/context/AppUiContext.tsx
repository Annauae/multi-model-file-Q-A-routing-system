/**
 * AppUiContext — 全局 UI 状态层
 *
 * 职责：集中管理轻量级、跨页面的 UI 反馈（Toast 提示、Modal 弹窗），
 * 避免在各 View 中重复实现通知与对话框逻辑。
 *
 * 使用方式：
 * 1. 在应用根节点用 <AppUiProvider> 包裹（见 App.tsx）
 * 2. 在根节点同级挂载 <ToastContainer /> 与 <ModalOverlay /> 作为 UI 出口
 * 3. 任意子组件通过 useAppUi() 调用 showToast / showModal / hideModal
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** Toast 的视觉类型，对应 CSS 类名 toast.success / toast.error */
type ToastType = "success" | "error";

/** 单条 Toast 的内存结构；id 用于定时移除时精确定位 */
interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

/** 弹窗 打开时的完整状态；body 支持任意 React 节点（表单、文本等） */
interface ModalState {
  title: string;
  body: ReactNode;
  /** 为 true 时应用 modalWide 样式，适合宽表单或表格 */
  wide?: boolean;
  /** 点击「确定」时执行；支持 async，失败时由 弹窗遮罩层 捕获并弹出 error Toast */
  onOk?: () => void | Promise<void>;
}

/** 上下文对外暴露的 API 与只读状态 */
interface AppUiContextValue {
  toasts: ToastItem[];
  showToast: (message: string, type?: ToastType, durationMs?: number) => void;
  modal: ModalState | null;
  showModal: (title: string, body: ReactNode, onOk?: () => void | Promise<void>, wide?: boolean) => void;
  hideModal: () => void;
}

/** 默认 null，便于 useAppUi 在 Provider 外使用时抛出明确错误 */
const AppUiContext = createContext<AppUiContextValue | null>(null);

/**
 * Provider：持有 toasts / modal 状态，并向子树注入操作方法。
 * children 为整个应用或需要访问 UI API 的子树。
 */
export function AppUiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]); // 存储 Toast 列表
  const [modal, setModal] = useState<ModalState | null>(null); // 存储 Modal 状态

  /**
   * 追加一条 Toast，并在 durationMs 后自动移除。
   * id 使用 Date.now() + Math.random()，避免同一毫秒内多条 Toast 冲突。
   */
  const showToast = useCallback((message: string, type: ToastType = "success", durationMs = 2600) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), durationMs);
  }, []);

  /** 打开 Modal；同一时间仅保留一个（新调用会覆盖 modal 状态） */
  const showModal = useCallback((title: string, body: ReactNode, onOk?: () => void | Promise<void>, wide?: boolean) => {
    setModal({ title, body, onOk, wide });
  }, []);

  /** 关闭 Modal，将 modal 置为 null */
  const hideModal = useCallback(() => setModal(null), []);

  /** 合并状态与方法，依赖变化时才更新，减少子组件无效重渲染 */
  const value = useMemo(
    () => ({ toasts, showToast, modal, showModal, hideModal }),
    [toasts, showToast, modal, showModal, hideModal],
  );

  return <AppUiContext.Provider value={value}>{children}</AppUiContext.Provider>;
}

/**
 * 消费 Context 的 Hook。
 * 必须在 AppUiProvider 内部调用，否则抛错（防止静默返回 undefined）。
 */
export function useAppUi() {
  const ctx = useContext(AppUiContext);
  if (!ctx) throw new Error("useAppUi must be used within AppUiProvider");
  return ctx;
}

/**
 * Toast 列表渲染容器，通常放在 App 根布局固定位置（如右上角）。
 * 仅订阅 toasts，不持有本地状态。
 */
export function ToastContainer() {
  const { toasts } = useAppUi();
  return (
    <div className="toastContainer" id="toastContainer">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

/**
 * 全局 Modal 遮罩层。
 * modal 为 null 时不渲染；有 onOk 时「确定」会 await 回调，成功则关闭，失败则 error Toast。
 */
export function ModalOverlay() {
  const { modal, hideModal, showToast } = useAppUi();
  if (!modal) return null;

  const handleOk = async () => {
    if (!modal.onOk) {
      hideModal();
      return;
    }
    try {
      await modal.onOk();
      hideModal();
    } catch (e) {
      // 错误 Toast 显示时间略长（3.2s），便于用户阅读错误信息
      showToast((e as Error).message || String(e), "error", 3200);
    }
  };

  return (
    <div className="modalOverlay" id="modalOverlay">
      <div className={`modal ${modal.wide ? "modalWide" : ""}`}>
        <div className="modalHead">
          <h3 id="modalTitle">{modal.title}</h3>
        </div>
        <div className="modalBody" id="modalBody">
          {modal.body}
        </div>
        <div className="modalFoot">
          <button type="button" className="btn ghost" id="modalCancelBtn" onClick={hideModal}>
            取消
          </button>
          <button type="button" className="btn primary" id="modalOkBtn" onClick={() => void handleOk()}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
