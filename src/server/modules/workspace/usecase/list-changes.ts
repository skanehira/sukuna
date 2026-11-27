import { err, ok, type Result } from "neverthrow";
import type { ChangesResponse } from "../../../../shared/files";
import { aggregateChanges } from "../domain/changes";
import type { WorkspaceDependencies, WorkspaceError } from "../domain/ports";
import { normalizeDiffs } from "./normalize-diffs";
import { workspaceContext } from "./workspace-context";

export async function listChanges(
  id: string,
  deps: WorkspaceDependencies,
): Promise<Result<ChangesResponse, WorkspaceError>> {
  const context = await workspaceContext(id, deps);
  if (context.isErr()) return err(context.error);
  const events = deps.repository.diffs(id);
  if (events.isErr()) return err(events.error);
  const normalized = await normalizeDiffs(context.value.cwd, events.value, deps.fs);
  if (normalized.isErr()) return err(normalized.error);
  return ok(aggregateChanges(normalized.value));
}
