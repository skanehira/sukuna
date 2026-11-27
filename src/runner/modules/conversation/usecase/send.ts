import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, InputAcceptance, OperationError } from "./runtime";
import type { SendResult } from "../domain/conversation-store";
import type { SendInput } from "./runtime";
import { activeStates, conflict } from "./runtime";
export function send(
  this: ConversationRuntime,
  id: string,
  input: SendInput,
): Promise<Result<SendResult, OperationError>> {
  return this.serial(id, () => sendUnlocked.call(this, id, input));
}
export async function sendUnlocked(
  this: ConversationRuntime,
  id: string,
  input: SendInput,
  acceptance?: InputAcceptance,
): Promise<Result<SendResult, OperationError>> {
  const c = this.store.get(id);
  if (!c) return err({ code: "not_found", message: "会話が見つかりません。" });
  if (this.closing) return err(conflict());
  if (input.clientId) {
    const prior = this.store.duplicate(id, input.clientId, this.options.clock.now() - 600000);
    if (prior) return ok(prior);
  }
  if (activeStates.includes(c.runState) && !input.interrupt) {
    const queue = this.store.queue(id);
    const queuedId = this.options.id();
    this.record(id, acceptance?.events ?? [], () => {
      acceptance?.before();
      this.store.enqueue({
        id: queuedId,
        conversationId: id,
        text: input.text,
        images: input.images,
        position: (queue.at(-1)?.position ?? 0) + 1,
        clientId: input.clientId ?? null,
        createdAt: this.options.clock.now(),
      });
    });
    this.partsChanged(id, ["queue"]);
    return ok({ result: "queued", queuedId });
  }
  if (activeStates.includes(c.runState)) await this.interrupt(id, "interrupt");
  return ok(
    this.deliver(
      id,
      {
        ...input,
        origin: input.interrupt && activeStates.includes(c.runState) ? "interrupt" : input.origin,
      },
      acceptance,
    ),
  );
}
