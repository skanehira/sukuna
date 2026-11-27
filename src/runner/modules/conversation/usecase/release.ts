import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, OperationError } from "./runtime";
import type { RunState } from "../../../../shared/events";
import { activeStates } from "./runtime";
export function release(
  this: ConversationRuntime,
  id: string,
  callerCancelled?: () => boolean,
): Promise<Result<{ runState: RunState }, OperationError>> {
  return this.serial(id, () => releaseUnlocked.call(this, id), callerCancelled);
}
export async function releaseUnlocked(
  this: ConversationRuntime,
  id: string,
): Promise<Result<{ runState: RunState }, OperationError>> {
  const c = this.store.get(id);
  if (!c) return err({ code: "not_found", message: "会話が見つかりません。" });
  if (activeStates.includes(c.runState)) await this.interrupt(id, "user");
  this.timers.cancel(id);
  const execution = this.executions.get(id);
  execution?.session.close();
  if (execution) await execution.consuming;
  this.executions.delete(id);
  return ok({ runState: this.store.get(id)?.runState ?? c.runState });
}
