import { err, ok, type Result } from "neverthrow";
import {
  deletionConflict,
  lifecycleConflict,
  lifecycleMissing,
  type LifecycleDependencies,
  type LifecycleError,
} from "../domain/lifecycle";
import { withFamilyReservations } from "./reserve-family";

export function deleteConversation(
  id: string,
  deps: LifecycleDependencies,
): Promise<Result<{ deleted: string[] }, LifecycleError>> {
  const key = deps.repository.conversation(id)?.parentId ?? id;
  return deps.serial(key, async () => {
    const current = deps.repository.conversation(id);
    if (!current) return err(lifecycleMissing);
    if (current.kind !== "chat" && current.kind !== "thread") return err(deletionConflict);
    return withFamilyReservations([id], false, deps, (parent) => {
      const children =
        current.kind === "chat"
          ? deps.repository
              .threads(id)
              .filter((thread) => thread.projectId === current.projectId)
              .map(({ id }) => id)
          : [];
      const ids = [id, ...children];
      return withFamilyReservations(children, false, deps, async (reservations) => {
        await deps.withdraw({ kind: "conversations", ids });
        const result = deps.repository.transaction(() => {
          if (!deps.repository.activeReservations([...parent, ...reservations]))
            return err(lifecycleConflict);
          deps.repository.delete(ids);
          return ok({ deleted: ids });
        });
        if (result.isErr()) return result;
        await Promise.all(ids.map((id) => deps.removeImages(id)));
        deps.changed(
          current.projectId,
          ids,
          current.kind === "thread" ? (current.parentId ?? undefined) : undefined,
        );
        return result;
      });
    });
  });
}
