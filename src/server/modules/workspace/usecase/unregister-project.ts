import { err, ok, type Result } from "neverthrow";
import {
  projectNotFound,
  type ProjectDependencies,
  type ProjectError,
} from "../domain/project-settings";

export async function unregisterProject(
  id: string,
  deps: ProjectDependencies,
): Promise<Result<{ stoppedConversationIds: string[] }, ProjectError>> {
  if (deps.repository.find(id)?.removedAt !== null) return err(projectNotFound);
  const lease = deps.reserve(id);
  if (lease.isErr()) return err(lease.error);
  let stoppedConversationIds: string[];
  try {
    if (deps.repository.find(id)?.removedAt !== null) return err(projectNotFound);
    const stopped = await deps.stop(id);
    if (stopped.isErr()) return err(stopped.error);
    const removed = deps.transaction(() => {
      if (deps.repository.find(id)?.removedAt !== null) return false;
      const removedAt = deps.now();
      deps.repository.update(id, { removedAt });
      deps.notifications?.dismissProject(id, removedAt);
      return true;
    });
    if (!removed) return err(projectNotFound);
    stoppedConversationIds = stopped.value;
  } finally {
    lease.value.release();
  }
  await deps.changed(id);
  return ok({ stoppedConversationIds });
}
