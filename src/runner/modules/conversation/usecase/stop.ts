import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, OperationError } from "./runtime";
import type { RunState } from "../../../../shared/events";
import { activeStates, conflict } from "./runtime";
export function stop(
  this: ConversationRuntime,
  id: string,
): Promise<Result<{ runState: RunState }, OperationError>> {
  return this.serial(id, async () => {
    const c = this.store.get(id);
    if (!c || !activeStates.includes(c.runState)) return err(conflict());
    await this.interrupt(id, "user");
    return ok({ runState: this.store.get(id)?.runState ?? "stopped" });
  });
}
