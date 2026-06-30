export type AskMode = "llm" | "rag";

export function ModeSwitch({ mode, onChange }: { mode: AskMode; onChange: (m: AskMode) => void }) {
  return (
    <div className="segmentedControl modeSwitch" role="group" aria-label="问答模式">
      <button
        type="button"
        className={`segmentedBtn ${mode === "llm" ? "active" : ""}`}
        onClick={() => onChange("llm")}
      >
        回答模型
      </button>
      <button
        type="button"
        className={`segmentedBtn ${mode === "rag" ? "active" : ""}`}
        onClick={() => onChange("rag")}
      >
        RAG
      </button>
    </div>
  );
}
