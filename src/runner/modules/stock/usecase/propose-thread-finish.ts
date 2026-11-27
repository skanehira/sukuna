import { err, ok } from "neverthrow";
import {
  activeStates,
  conflict,
  type ConversationRuntime,
  type OperationError,
} from "../../conversation/usecase/runtime";
import { cancelledStockSend } from "./stock-send-refused";

const proposal =
  "このスレッドで確定した事項を、元の会話の AI への指示として書いてください。出力は指示の文だけにしてください。確定した事項が無ければ『なし』とだけ書いてください。";

export function threadFinishRefusal(
  runtime: ConversationRuntime,
  id: string,
): OperationError | null {
  const thread = runtime.store.get(id);
  if (!thread || thread.kind !== "thread")
    return { code: "not_found", message: "スレッドがありません" };
  if (thread.closedAt !== null) return conflict("このスレッドはすでに終えています");
  if (activeStates.includes(thread.runState))
    return conflict("スレッドの AI が作業中です。止めるか、終わってから選んでください");
  return null;
}

export function proposeThreadFinish(
  runtime: ConversationRuntime,
  id: string,
  cancelled: () => boolean,
) {
  if (runtime.releases.has(id)) return Promise.resolve(err(conflict()));
  return runtime.serial(id, async () => {
    const expired = () => (cancelled() || runtime.closing ? cancelledStockSend : null);
    const check = () => expired() ?? threadFinishRefusal(runtime, id);
    const refused = check();
    if (refused) return err(refused);
    const events = runtime.store.events(id);
    const lastInput = events.findLastIndex((event) => event.type === "user_message");
    const request = events[lastInput];
    if (request?.type === "user_message" && request.payload.origin === "finish_proposal") {
      const turn = events.slice(lastInput + 1);
      const boundary = turn.findIndex(
        (event) =>
          event.type === "turn_end" || event.type === "stopped" || event.type === "resumed",
      );
      const end = turn[boundary];
      const text = turn
        .slice(0, Math.max(0, boundary))
        .findLast(
          (event) => event.type === "assistant_text" && event.payload.parent_tool_use_id === null,
        );
      if (
        end?.type === "turn_end" &&
        end.payload.subtype === "success" &&
        turn[boundary + 1]?.type !== "stopped" &&
        text?.type === "assistant_text" &&
        text.payload.text.trim().length > 0
      )
        return ok({ runState: "working" as const });
    }
    try {
      const result = await runtime.deliver(
        id,
        { text: proposal, images: [], origin: "finish_proposal" },
        { events: [], check, checkBeforeCommit: expired },
        { includeQueued: false, recordOpeningFailure: false },
      );
      return result.map(() => ({ runState: "working" as const }));
    } catch (error) {
      runtime.options.log(
        { conversationId: id, issueId: null },
        "確定事項の案を求められませんでした。",
        error,
      );
      return err(cancelledStockSend);
    }
  });
}
