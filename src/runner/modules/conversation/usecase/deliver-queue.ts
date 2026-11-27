import { err, ok, type Result } from "neverthrow";
import {
  activeStates,
  callerInputAcceptance,
  conflict,
  type ConversationRuntime,
  type DeliveryError,
} from "./runtime";

export function deliverQueue(
  this: ConversationRuntime,
  id: string,
  callerCancelled?: () => boolean,
): Promise<Result<{ seq: number }, DeliveryError>> {
  const deliverPending = async () => {
    const conversation = this.store.get(id);
    if (
      !conversation ||
      this.closing ||
      activeStates.includes(conversation.runState) ||
      !this.store.queue(id).length
    )
      return err(conflict());
    const allowed = await this.runOptions.allowDelivery(conversation, {
      text: "",
      images: [],
      origin: "queued",
    });
    if (allowed.isErr()) return err(allowed.error);
    const current = this.store.get(id);
    if (!current || this.closing || activeStates.includes(current.runState)) return err(conflict());
    const result = await this.deliver(
      id,
      { text: "", images: [], origin: "queued" },
      callerInputAcceptance(callerCancelled),
    );
    return result.andThen((sent) =>
      sent.result === "delivered" ? ok({ seq: sent.seq }) : err(conflict()),
    );
  };
  return this.serial(id, deliverPending, callerCancelled);
}
