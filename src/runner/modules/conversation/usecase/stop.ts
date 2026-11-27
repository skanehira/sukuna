import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, OperationError } from "./runtime";
import type { RunState } from "../../../../shared/events";
import { activeStates, conflict } from "./runtime";
export function stop(
  this: ConversationRuntime,
  id: string,
  stillCurrent = () => true,
  onFailure?: () => void,
  callerCancelled?: () => boolean,
  intent: "user" | "dependency_withdrawn" = "user",
): Promise<Result<{ runState: RunState }, OperationError>> {
  const interruptCurrent = async () => {
    const c = this.store.get(id);
    if (!stillCurrent() || !c || !activeStates.includes(c.runState)) return err(conflict());
    try {
      await this.interrupt(id, intent);
    } catch (error) {
      onFailure?.();
      throw error;
    }
    return ok<{ runState: RunState }>({ runState: this.store.get(id)?.runState ?? "stopped" });
  };
  return this.serial(id, interruptCurrent, callerCancelled);
}
