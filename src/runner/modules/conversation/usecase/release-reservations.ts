import { err, ok, type Result } from "neverthrow";
import { conflict, type ConversationRuntime, type OperationError } from "./runtime";
import { releaseUnlocked } from "./release";
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
  reserve(id: string): Promise<Result<{ token: string }, OperationError>> {
    if (this.pending.has(id)) return Promise.resolve(err(conflict()));
    const runtime = this.runtime;
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
    const reservation: Reservation = {
      token,
      finish: () => {
        if (this.pending.get(id) !== reservation) return ok(undefined);
        const removed = runtime.store.clearRelease(id, token);
        cancel();
        this.pending.delete(id);
        finish();
        return removed.mapErr((error) => ({ code: "internal" as const, message: error.message }));
      },
    };
    this.pending.set(id, reservation);
    void runtime
      .serial(id, async () => {
        const released = await releaseUnlocked.call(runtime, id);
        if (released.isErr()) return err(released.error);
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
      })
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
