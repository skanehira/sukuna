import { err, ok, type Result } from "neverthrow";
import type { NameSearchResponse } from "../../../../shared/files";
import type { WorkspaceDependencies, WorkspaceError } from "../domain/ports";

export async function searchNames(
  cwd: string,
  query: string,
  deps: WorkspaceDependencies,
): Promise<Result<NameSearchResponse, WorkspaceError>> {
  const files = await deps.search.files(cwd);
  if (files.isErr()) return err(files.error);
  const words = query.toLowerCase().trim().split(/\s+/);
  const matches = files.value.filter((path) =>
    words.every((word) => path.toLowerCase().includes(word)),
  );
  return ok({
    mode: "name",
    query,
    matches: matches.slice(0, 200).map((path) => ({ path })),
    truncated: matches.length > 200,
  });
}
