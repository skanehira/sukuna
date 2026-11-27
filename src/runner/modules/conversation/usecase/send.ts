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
  if (this.releases.has(id)) {
    if (input.clientId) {
      const prior = this.store.duplicate(id, input.clientId, this.options.clock.now() - 600000);
      if (prior) return Promise.resolve(ok(prior));
    }
    return Promise.resolve(err(conflict()));
  }
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
  if (input.text.length === 0 && input.images.length === 0 && this.store.queue(id).length === 0)
    return err({ code: "invalid_input", message: "入力を確認してください。" });
  if (activeStates.includes(c.runState) && !input.interrupt) {
    for (const imageId of input.images) {
      const image = this.options.images.read(id, imageId);
      if (image.isErr()) return err(image.error);
    }
    const queue = this.store.queue(id);
    const queuedId = this.options.id();
    this.record(id, acceptance?.events ?? [], () => {
      acceptance?.before();
      this.store.enqueue({
        id: queuedId,
        conversationId: id,
        text: input.text,
        images: input.images,
        ...(input.timelineComments === undefined
          ? {}
          : { timelineComments: input.timelineComments }),
        position: (queue.at(-1)?.position ?? 0) + 1,
        clientId: input.clientId ?? null,
        createdAt: this.options.clock.now(),
      });
    });
    this.partsChanged(id, ["queue"]);
    return ok({ result: "queued", queuedId });
  }
  return this.deliver(
    id,
    {
      ...input,
      origin: input.interrupt && activeStates.includes(c.runState) ? "interrupt" : input.origin,
    },
    acceptance,
    { interrupt: activeStates.includes(c.runState) },
  );
}
