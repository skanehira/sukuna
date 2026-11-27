import type { StockSendReceipt } from "../../../../shared/stock-send-receipts";
import type { Conversation } from "../../conversation/domain/conversation-store";
import { activeStates, type ConversationRuntime } from "../../conversation/usecase/runtime";
import type { StockSendResponse } from "../../../../shared/stock";
import { formatThreadQuestion } from "../domain/message-format";
import type { OutgoingStock, OutgoingStockRepository } from "../domain/ports";
import { cancelledStockSend, stockChanged, StockSendRefused } from "./stock-send-refused";

type QuestionResult = StockSendResponse["questions"][number];

export function canForkStockHistory(runtime: ConversationRuntime, source: Conversation): boolean {
  return (
    source.sessionId !== null &&
    runtime.store
      .events(source.id)
      .some(
        (event) =>
          (event.type === "assistant_text" && event.payload.text.trim().length > 0) ||
          event.type === "tool_use" ||
          event.type === "tool_result" ||
          event.type === "question" ||
          event.type === "permission_request",
      )
  );
}

export async function startStockThread(
  runtime: ConversationRuntime,
  repository: OutgoingStockRepository,
  source: Conversation,
  item: OutgoingStock,
  stale: boolean,
  cancelled: () => boolean,
  receipt: StockSendReceipt | undefined,
): Promise<QuestionResult> {
  const fail = (detail: string): QuestionResult => ({
    stockId: item.id,
    ok: false,
    error: { code: "fork_failed", message: `スレッドを始められませんでした。${detail}` },
  });
  if (source.sessionId === null)
    return {
      stockId: item.id,
      ok: false,
      error: {
        code: "no_session",
        message: "元の会話に AI の応答がまだ無いため、スレッドを始められません",
      },
    };
  if (cancelled() || runtime.closing) return fail(cancelledStockSend.message);
  try {
    const parent = runtime.store.get(source.id);
    if (
      !parent ||
      parent.cwd !== source.cwd ||
      parent.worktreeId !== source.worktreeId ||
      parent.sessionId !== source.sessionId
    )
      return fail(stockChanged.message);
    const parentActive = activeStates.includes(parent.runState);
    const fork = await runtime.options.agent.fork(source.sessionId, { dir: source.cwd });
    if (fork.isErr()) return fail(fork.error.message);
    const text = formatThreadQuestion({ ...item, stale }, parentActive);
    const expired = () => (cancelled() || runtime.closing ? cancelledStockSend : null);
    const started = await runtime.start(
      {
        kind: "thread",
        projectId: source.projectId,
        cwd: source.cwd,
        worktreeId: source.worktreeId,
        parentConversationId: source.id,
        title: Array.from(item.text.split(/\r?\n/, 1)[0] ?? "")
          .slice(0, 40)
          .join(""),
        sessionId: fork.value.sessionId,
      },
      {
        message: { text, images: [], origin: "stock" },
        acceptance: (threadId) => ({
          events: [],
          check: expired,
          checkBeforeCommit: expired,
          before: () => {
            const latest = runtime.store.get(source.id);
            if (
              !latest ||
              latest.cwd !== source.cwd ||
              latest.worktreeId !== source.worktreeId ||
              latest.sessionId !== source.sessionId
            )
              throw new StockSendRefused(stockChanged);
            if (!repository.markSent(item, { at: runtime.options.clock.now(), threadId }))
              throw new StockSendRefused(stockChanged);
            receipt?.question({ stockId: item.id, ok: true, threadId });
          },
        }),
      },
    );
    if (started.isErr()) return fail(started.error.message);
    const threadId = started.value.conversationId;
    return { stockId: item.id, ok: true, threadId };
  } catch (failure) {
    return fail(failure instanceof Error ? failure.message : "もう一度操作してください。");
  }
}
