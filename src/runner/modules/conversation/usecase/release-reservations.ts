import {
  releaseCleanupFailure,
  type ConversationStore,
  type ReleaseCleanupFailure,
} from "../domain/conversation-store";
import { err, ok, type Result } from "neverthrow";
import { closeWhileWorkingMessage } from "../../../../shared/lifecycle";
import { activeStates, conflict, type ConversationRuntime, type OperationError } from "./runtime";
import { releaseUnlocked } from "./release";
const clearRetryMs = 250;

function clearInTransaction(
  store: ConversationStore,
  id: string,
  token: string,
): Result<void, ReleaseCleanupFailure> {
  try {
    return store.transaction(() => store.clearReleaseInTransaction(id, token));
  } catch {
    return err(releaseCleanupFailure);
  }
}

type Reservation = { token: string; finish: () => Result<void, OperationError> };
export class ReleaseReservations {
  private pending = new Map<string, Reservation>();
  private runtime: ConversationRuntime;
  constructor(runtime: ConversationRuntime) {
    this.runtime = runtime;
  }
  has(id: string): boolean {
    return this.pending.has(id);
  }
  reserve(
    id: string,
    {
      beforeRelease,
      onlyIdle = false,
      callerCancelled = () => false,
    }: {
      beforeRelease?: () => OperationError | null;
      onlyIdle?: boolean;
      callerCancelled?: () => boolean;
    } = {},
  ): Promise<Result<{ token: string }, OperationError>> {
    if (this.pending.has(id)) return Promise.resolve(err(conflict()));
    const runtime = this.runtime;
    const cancelled = () =>
      err({
        code: "runner_unavailable" as const,
        message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
      });
    let ready: (result: Result<{ token: string }, OperationError>) => void;
    const result = new Promise<Result<{ token: string }, OperationError>>((resolve) => {
      ready = resolve;
    });
    let finish: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const token = runtime.options.uuid();
    let cancel = () => {};
    const beforeReservation = runtime.store.get(id);
    const reservation: Reservation = {
      token,
      finish: () => {
        if (this.pending.get(id) !== reservation) return ok(undefined);
        const removed = clearInTransaction(runtime.store, id, token);
        cancel();
        if (removed.isErr() && !removed.error.unusable && !runtime.closing) {
          cancel = runtime.options.clock.setTimeout(() => {
            reservation.finish();
          }, clearRetryMs);
          return err({ code: "internal", message: removed.error.message });
        }
        this.pending.delete(id);
        finish();
        const current = runtime.store.get(id);
        const restore =
          !runtime.closing &&
          current?.runState === "usage_limited" &&
          current.closedAt === null &&
          !runtime.store.isUsageTimerRetired(id, current.lastSeq) &&
          (current.parentConversationId === null ||
            runtime.store.get(current.parentConversationId)?.closedAt === null);
        runtime.timers.finishSuspension(id, restore);
        if (
          beforeReservation?.kind === "thread" &&
          current?.closedAt === null &&
          current.runState !== beforeReservation.runState &&
          current.parentConversationId
        )
          runtime.partsChanged(current.parentConversationId, ["stock", "threads"]);
        return removed.mapErr((error) => ({ code: "internal" as const, message: error.message }));
      },
    };
    this.pending.set(id, reservation);
    runtime.timers.suspend(id);
    void runtime
      .serial(
        id,
        async () => {
          if (callerCancelled()) return cancelled();
          const current = runtime.store.get(id);
          if (onlyIdle && current && activeStates.includes(current.runState))
            return err(conflict(closeWhileWorkingMessage));
          const refused = beforeRelease?.();
          if (refused) return err(refused);
          const released = await releaseUnlocked.call(runtime, id, { preserveUsageTimer: true });
          if (released.isErr()) return err(released.error);
          if (callerCancelled()) return cancelled();
          if (runtime.closing) return err(conflict());
          runtime.store.reserveRelease(id, token, 10_000);
          cancel = runtime.options.clock.setTimeout(() => {
            const removed = reservation.finish();
            if (removed.isErr())
              runtime.options.log({ conversationId: id, issueId: null }, removed.error.message);
          }, 10_000);
          ready(ok({ token }));
          await finished;
          return ok(undefined);
        },
        callerCancelled,
      )
      .then((done) => {
        if (done.isErr()) ready(err(done.error));
        if (this.pending.get(id) === reservation) reservation.finish();
      });
    return result;
  }
  complete(id: string, token: string): Result<void, OperationError> {
    const reservation = this.pending.get(id);
    if (!reservation || reservation.token !== token) return err(conflict());
    return reservation.finish();
  }
  clear(): void {
    for (const reservation of this.pending.values()) reservation.finish();
  }
}
