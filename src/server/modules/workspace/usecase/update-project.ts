import { err, ok, type Result } from "neverthrow";
import type { ProjectPatch, ProjectSettings } from "../../../../shared/api/project";
import {
  invalidProjectName,
  projectNameTaken,
  projectNotFound,
  validProjectName,
  type ProjectDependencies,
  type ProjectError,
} from "../domain/project-settings";

export async function updateProject(
  id: string,
  input: ProjectPatch,
  deps: ProjectDependencies,
): Promise<Result<ProjectSettings, ProjectError>> {
  const first = deps.repository.find(id);
  if (first?.removedAt !== null) return err(projectNotFound);
  if (input.name !== undefined && !validProjectName(input.name)) return err(invalidProjectName);
  if (input.usesGithub === true) {
    const github = await deps.github.inspect(await deps.git.origin(first.path), first.path);
    if (!github.available)
      return err({
        code: "invalid_input",
        message:
          github.reason ?? "GitHub を使うには、origin に GitHub のリポジトリを指定してください。",
      });
  }
  if (!Object.keys(input).length) return ok(deps.repository.settings(first));
  const validateBranch = input.defaultBranch !== undefined || input.usesGithub !== undefined;
  for (;;) {
    const project = deps.repository.find(id);
    if (project?.removedAt !== null) return err(projectNotFound);
    const usesGithub = input.usesGithub ?? project.usesGithub;
    const defaultBranch = input.defaultBranch ?? project.defaultBranch;
    const validBranch =
      !validateBranch || (await deps.git.hasBranch(project.path, defaultBranch, usesGithub));
    const result = deps.transaction((): Result<ProjectSettings, ProjectError> | null => {
      const latest = deps.repository.find(id);
      if (latest?.removedAt !== null) return err(projectNotFound);
      const updated = { ...latest, ...input };
      if (
        validateBranch &&
        (updated.usesGithub !== usesGithub || updated.defaultBranch !== defaultBranch)
      )
        return null;
      if (input.name !== undefined && deps.repository.nameTaken(input.name, id))
        return err(projectNameTaken);
      if (!updated.usesGithub && updated.designMergeMode === "pr")
        return err({
          code: "invalid_input",
          message: "設計書を PR で反映するには、GitHub を使う設定にしてください。",
        });
      if (!validBranch)
        return err({
          code: "invalid_input",
          message: usesGithub
            ? "指定された既定ブランチが手元にも origin にもありません。"
            : "指定された既定ブランチが手元にありません。",
        });
      deps.repository.update(id, input);
      return ok(deps.repository.settings(updated));
    });
    if (result === null) continue;
    if (result.isOk()) await deps.changed(id);
    return result;
  }
}
