import { prepareAcceptance } from "./run-options";
import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, DeliveryError, InputAcceptance } from "./runtime";
import type { ProjectRunReservation, SendResult } from "../domain/conversation-store";
import type { SendInput } from "./runtime";
import { activeStates, callerInputAcceptance, conflict, InputRefused } from "./runtime";
export function send(
  this: ConversationRuntime,
  id: string,
  input: SendInput,
  accepted?: (fresh: boolean) => void,
  projectRun?: ProjectRunReservation,
  callerCancelled?: () => boolean,
): Promise<Result<SendResult, DeliveryError>> {
  if (this.releases.has(id)) {
    if (input.clientId) {
      const prior = this.store.duplicate(id, input.clientId, this.options.clock.now() - 600000);
      if (prior) {
        accepted?.(false);
        return Promise.resolve(ok(prior));
      }
    }
    return Promise.resolve(err(conflict()));
  }
  return this.serial(
    id,
    () =>
      sendUnlocked.call(
        this,
        id,
        input,
        callerInputAcceptance(callerCancelled),
        accepted,
        projectRun,
      ),
    callerCancelled,
  );
}
export async function sendUnlocked(
  this: ConversationRuntime,
  id: string,
  input: SendInput,
  acceptance?: InputAcceptance,
  accepted?: (fresh: boolean) => void,
  projectRun?: ProjectRunReservation,
): Promise<Result<SendResult, DeliveryError>> {
  let c = this.store.get(id);
  if (!c) return err({ code: "not_found", message: "会話が見つかりません。" });
  if (this.closing) return err(conflict());
  if (input.clientId) {
    const prior = this.store.duplicate(id, input.clientId, this.options.clock.now() - 600000);
    if (prior) {
      accepted?.(false);
      return ok(prior);
    }
  }
  const allowed = await this.runOptions.allowDelivery(c, input);
  const refused = acceptance?.check?.();
  if (refused) return err(refused);
  if (allowed.isErr()) return err(allowed.error);
  c = this.store.get(id);
  if (!c) return err({ code: "not_found", message: "会話が見つかりません。" });
  if (this.closing) return err(conflict());
  if (input.text.length === 0 && input.images.length === 0 && this.store.queue(id).length === 0)
    return err({ code: "invalid_input", message: "入力を確認してください。" });
  if (activeStates.includes(c.runState) && !input.interrupt) {
    for (const imageId of input.images) {
      const image = this.options.images.read(id, imageId);
      if (image.isErr()) return err(image.error);
    }
    const queue = this.store.queue(id);
    const queuedId = this.options.id();
    this.record(
      id,
      acceptance?.events ?? [],
      () => {
        const refused = acceptance?.check?.();
        if (refused) throw new InputRefused(refused);
        acceptance?.before?.();
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
      },
      undefined,
      () => {
        const refused = acceptance?.checkBeforeCommit?.();
        if (refused) throw new InputRefused(refused);
      },
    );
    this.partsChanged(id, ["queue"]);
    accepted?.(true);
    return ok({ result: "queued", queuedId });
  }
  const prepared = await this.runOptions.prepareDelivery(c, input, "message", () =>
    Boolean(acceptance?.check?.()),
  );
  if (prepared.isErr()) return err(prepared.error);
  const { input: instruction, committed, rejected, release, prefix } = prepared.value;
  try {
    const delivered = await this.deliver(
      id,
      {
        ...instruction,
        origin:
          instruction.interrupt && activeStates.includes(c.runState)
            ? "interrupt"
            : instruction.origin,
      },
      prepareAcceptance(prepared.value, acceptance),
      { interrupt: activeStates.includes(c.runState), projectRun, prefix, checkStage: "owner" },
    );
    if (delivered.isOk()) {
      committed?.();
      accepted?.(true);
    } else rejected?.();
    return delivered;
  } finally {
    release?.();
  }
}
