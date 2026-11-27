import { err, ok, type Result } from "neverthrow";
import type { Conversation } from "../domain/conversation-store";
import type { ConversationRuntime, DeliveryError, OperationError, SendInput } from "./runtime";
import { conflict } from "./runtime";

type ResumeSource = "developer" | "usage_limit" | "flow";
type ResumeChecks = { callerCancelled?: () => boolean; usageTimerCurrent?: () => boolean };

const unavailable: OperationError = {
  code: "runner_unavailable",
  message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
};

function resumable(c: Conversation | null, by: ResumeSource): c is Conversation {
  if (c === null) return false;
  if (by === "usage_limit") return c.runState === "usage_limited" && c.closedAt === null;
  return (
    c.runState === "failed" ||
    c.runState === "usage_limited" ||
    (c.runState === "stopped" && c.stopReason === "restarted")
  );
}

export function resume(
  this: ConversationRuntime,
  id: string,
  by: ResumeSource = "developer",
  checks: ResumeChecks = {},
): Promise<Result<{ seq: number }, DeliveryError>> {
  if (checks.callerCancelled?.()) return Promise.resolve(err(unavailable));
  if (this.releases.has(id)) return Promise.resolve(err(conflict()));
  return this.serial(id, async () => {
    const preflight = (): OperationError | null => {
      if (checks.callerCancelled?.()) return unavailable;
      if (
        this.closing ||
        this.releases.has(id) ||
        checks.usageTimerCurrent?.() === false ||
        !resumable(this.store.get(id), by)
      )
        return conflict();
      return null;
    };
    const started = preflight();
    if (started) return err(started);
    const c = this.store.get(id);
    if (!c) return err(conflict());
    if (["triage", "design", "impl"].includes(c.kind) && this.options.canResume) {
      const allowed = await this.options.canResume(c);
      const afterGate = preflight();
      if (afterGate) return err(afterGate);
      if (!allowed) return err(conflict());
    }
    const input: SendInput = {
      text: "中断したところから続けてください。",
      images: [],
      origin: "resume",
    };
    if (by === "developer") {
      const allowed = await this.runOptions.allowDelivery(c, input);
      const afterGate = preflight();
      if (afterGate) return err(afterGate);
      if (allowed.isErr()) return err(allowed.error);
    }
    const sent = await this.deliver(
      id,
      input,
      {
        events: [{ type: "resumed", payload: { by } }],
        check: preflight,
        checkBeforeCommit: () => (checks.callerCancelled?.() ? unavailable : null),
      },
      { includeQueued: false, reopensAfterAcceptance: by === "developer" },
    );
    if (sent.isErr()) return err(sent.error);
    if (by === "usage_limit")
      this.options.notice(id, "利用枠が戻ったため、作業を再開しました。", "info");
    return ok({ seq: sent.value.result === "delivered" ? sent.value.seq : 0 });
  });
}
