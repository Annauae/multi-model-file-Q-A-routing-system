import { LlmTurnSection } from "../views/DebugViews";
import { RagTurnSection } from "../views/RagDebugViews";
import type { AskChatTurn } from "../hooks/useAskSessions";

/** 按时间顺序展示全部问答轮次（LLM / RAG 混合），切换配置不清空历史 */
export function AskChatThread({
  turns,
  activeCardId,
}: {
  turns: AskChatTurn[];
  activeCardId?: string;
}) {
  return (
    <div className="askChatThread">
      {turns.map((turn) =>
        turn.mode === "llm" ? (
          <LlmTurnSection key={turn.id} turn={turn} kbId={turn.kbId} activeCardId={activeCardId} />
        ) : (
          <RagTurnSection key={turn.id} turn={turn} kbId={turn.kbId} activeCardId={activeCardId} />
        ),
      )}
    </div>
  );
}
