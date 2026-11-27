import { err, ok, type Result } from "neverthrow";
import { activeStates, conflict, type ConversationRuntime, type OperationError } from "./runtime";

export function deliverQueue(
  this: ConversationRuntime,
  id: string,
): Promise<Result<{ seq: number }, OperationError>> {
  return this.serial(id, async () => {
    const conversation = this.store.get(id);
    if (
      !conversation ||
      this.closing ||
      activeStates.includes(conversation.runState) ||
      !this.store.queue(id).length
    )
      return err(conflict());
    const result = this.deliver(id, { text: "", images: [], origin: "queued" });
    return result.result === "delivered" ? ok({ seq: result.seq }) : err(conflict());
  });
}
