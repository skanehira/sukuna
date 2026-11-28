import { err, ok, type Result } from "neverthrow";
import type { PathCandidates } from "../../../../shared/api/project";
import { matchesPathPrefix, parsePathQuery, pathCandidates } from "../domain/path-candidates";
import type { ProjectDependencies, ProjectError } from "../domain/project-settings";

export async function listPathCandidates(
  text: string,
  deps: Pick<ProjectDependencies, "readDirectory">,
): Promise<Result<PathCandidates, ProjectError>> {
  const query = parsePathQuery(text);
  if (query.isErr()) return err(query.error);
  const { directory, prefix } = query.value;
  const listing = await deps.readDirectory(directory, (name) => matchesPathPrefix(name, prefix));
  return ok(pathCandidates(query.value, listing));
}
