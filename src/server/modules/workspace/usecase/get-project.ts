import { err, ok, type Result } from "neverthrow";
import type { ProjectSettings } from "../../../../shared/api/project";
import {
  projectNotFound,
  type ProjectDependencies,
  type ProjectError,
} from "../domain/project-settings";

export function getProject(
  id: string,
  deps: ProjectDependencies,
): Result<ProjectSettings, ProjectError> {
  const project = deps.repository.find(id);
  return project?.removedAt === null ? ok(deps.repository.settings(project)) : err(projectNotFound);
}
