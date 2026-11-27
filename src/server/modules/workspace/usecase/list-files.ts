import { err, ok, type Result } from "neverthrow";
import type { FilesResponse } from "../../../../shared/files";
import { guardPath } from "../domain/path-guard";
import type { WorkspaceDependencies, WorkspaceError } from "../domain/ports";
import { normalizeDiffs } from "./normalize-diffs";
import { workspaceContext } from "./workspace-context";

export async function listFiles(
  id: string,
  deps: WorkspaceDependencies,
): Promise<Result<FilesResponse, WorkspaceError>> {
  const context = await workspaceContext(id, deps);
  if (context.isErr()) return err(context.error);
  const result = await deps.search.files(context.value.cwd);
  if (result.isErr()) return err(result.error);
  const events = deps.repository.diffs(id);
  if (events.isErr()) return err(events.error);
  const normalized = await normalizeDiffs(context.value.cwd, events.value, deps.fs);
  if (normalized.isErr()) return err(normalized.error);
  const changed: string[] = [];
  for (const path of new Set(normalized.value.map((event) => event.payload.path))) {
    const guarded = await guardPath(context.value.cwd, path, deps.fs);
    if (guarded.isErr()) {
      if (guarded.error.code === "internal") return err(guarded.error);
      continue;
    }
    const info = await deps.fs.stat(guarded.value.absolutePath);
    if (info.isErr()) {
      if (info.error.code === "internal") return err(info.error);
      continue;
    }
    if (!info.value.directory) changed.push(path);
  }
  return ok({
    files: result.value.slice(0, 20_000),
    truncated: result.value.length > 20_000,
    changed,
  });
}
