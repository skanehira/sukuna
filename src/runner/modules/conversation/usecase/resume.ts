import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, OperationError } from "./runtime";
import { conflict } from "./runtime";
export function resume(
  this: ConversationRuntime,
  id: string,
  by: "developer" | "usage_limit" | "flow" = "developer",
): Promise<Result<{ seq: number }, OperationError>> {
  if (this.releases.has(id)) return Promise.resolve(err(conflict()));
  return this.serial(id, async () => {
    const c = this.store.get(id);
    if (
      !c ||
      (by === "usage_limit" && c.closedAt !== null) ||
      !(
        c.runState === "failed" ||
        c.runState === "usage_limited" ||
        (c.runState === "stopped" && c.stopReason === "restarted")
      )
    )
      return err(conflict());
    if (
      ["triage", "design", "impl"].includes(c.kind) &&
      !(await (this.options.canResume?.(c) ?? Promise.resolve(true)))
    )
      return err(conflict());
    this.record(id, [{ type: "resumed", payload: { by } }]);
    const sent = await this.deliver(
      id,
      {
        text: "中断したところから続けてください。",
        images: [],
        origin: "resume",
      },
      undefined,
      { includeQueued: false },
    );
    if (sent.isErr()) return err(sent.error);
    if (by === "usage_limit")
      this.options.notice(id, "利用枠が戻ったため、作業を再開しました。", "info");
    return ok({ seq: sent.value.result === "delivered" ? sent.value.seq : 0 });
  });
}
