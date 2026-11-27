import { prepareAcceptance } from "./run-options";
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
    const input = { text: "", images: [], origin: "queued" as const };
    const allowed = await this.runOptions.allowDelivery(conversation, input);
    if (allowed.isErr()) return err(allowed.error);
    const current = this.store.get(id);
    if (!current || this.closing || activeStates.includes(current.runState)) return err(conflict());
    const prepared = await this.runOptions.prepareDelivery(
      current,
      input,
      "message",
      callerCancelled,
    );
    if (prepared.isErr()) return err(prepared.error);
    const { input: instruction, committed, rejected, release, prefix } = prepared.value;
    try {
      const accepted = callerInputAcceptance(callerCancelled);
      const result = await this.deliver(
        id,
        instruction,
        prepareAcceptance(prepared.value, accepted),
        { prefix, checkStage: "owner" },
      );
      if (result.isOk()) committed?.();
      else rejected?.();
      return result.andThen((sent) =>
        sent.result === "delivered" ? ok({ seq: sent.seq }) : err(conflict()),
      );
    } finally {
      release?.();
    }
  };
  return this.serial(id, deliverPending, callerCancelled);
}
