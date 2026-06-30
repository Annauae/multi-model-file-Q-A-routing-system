import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type ToastType = "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ModalState {
  title: string;
  body: ReactNode;
  wide?: boolean;
  onOk?: () => void | Promise<void>;
}

interface AppUiContextValue {
  toasts: ToastItem[];
  showToast: (message: string, type?: ToastType, durationMs?: number) => void;
  modal: ModalState | null;
  showModal: (title: string, body: ReactNode, onOk?: () => void | Promise<void>, wide?: boolean) => void;
  hideModal: () => void;
}

const AppUiContext = createContext<AppUiContextValue | null>(null);

export function AppUiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [modal, setModal] = useState<ModalState | null>(null);

  const showToast = useCallback((message: string, type: ToastType = "success", durationMs = 2600) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), durationMs);
  }, []);

  const showModal = useCallback((title: string, body: ReactNode, onOk?: () => void | Promise<void>, wide?: boolean) => {
    setModal({ title, body, onOk, wide });
  }, []);

  const hideModal = useCallback(() => setModal(null), []);

  const value = useMemo(
    () => ({ toasts, showToast, modal, showModal, hideModal }),
    [toasts, showToast, modal, showModal, hideModal],
  );

  return <AppUiContext.Provider value={value}>{children}</AppUiContext.Provider>;
}

export function useAppUi() {
  const ctx = useContext(AppUiContext);
  if (!ctx) throw new Error("useAppUi must be used within AppUiProvider");
  return ctx;
}

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
