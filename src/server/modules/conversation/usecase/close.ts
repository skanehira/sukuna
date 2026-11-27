import { err, ok, type Result } from "neverthrow";
import {
  closingConflict,
  isWorking,
  lifecycleConflict,
  lifecycleMissing,
  workingConflict,
  type LifecycleDependencies,
  type LifecycleError,
} from "../domain/lifecycle";
import { withFamilyReservations } from "./reserve-family";

export function closeConversation(
  id: string,
  stopIfWorking: boolean,
  deps: LifecycleDependencies,
): Promise<Result<{ closedAt: number }, LifecycleError>> {
  return deps.serial(id, async () => {
    const current = deps.repository.conversation(id);
    if (!current) return err(lifecycleMissing);
    if (current.kind !== "chat") return err(closingConflict);
    if (current.closedAt !== null) {
      await withdrawClosedNotifications(id, current.closedAt, deps);
      return ok({ closedAt: current.closedAt });
    }
    if (!stopIfWorking && isWorking(current.runState)) return err(workingConflict);
    return withFamilyReservations([id], !stopIfWorking, deps, (parent) => {
      const ids = deps.repository
        .threads(id)
        .filter((thread) => thread.projectId === current.projectId)
        .map(({ id }) => id);
      return withFamilyReservations(ids, false, deps, async (children) => {
        const result = deps.repository.transaction(() => {
          if (!deps.repository.activeReservations([...parent, ...children]))
            return err(lifecycleConflict);
          const at = deps.now();
          deps.repository.close(id, at, [id, ...ids]);
          return ok({ closedAt: at });
        });
        if (result.isErr()) return result;
        deps.changed(current.projectId, [id]);
        await withdrawClosedNotifications(id, result.value.closedAt, deps);
        return result;
      });
    });
  });
}

async function withdrawClosedNotifications(
  id: string,
  at: number,
  deps: LifecycleDependencies,
): Promise<void> {
  try {
    const ids = deps.repository.pendingWithdrawal(id, at);
    if (!ids) return;
    if (ids.length > 0) await deps.withdraw({ kind: "notifications", ids });
    deps.repository.completeWithdrawal(id, at);
  } catch (error) {
    deps.logWithdrawalFailure(id, error);
  }
}
