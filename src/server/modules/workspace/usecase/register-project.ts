import { err, ok, type Result } from "neverthrow";
import { basename } from "node:path";
import type { ProjectRegistered, ProjectRegistration } from "../../../../shared/api/project";
import {
  invalidProjectName,
  projectNameTaken,
  projectPathTaken,
  validProjectName,
  type ProjectDependencies,
  type ProjectError,
  type ProjectIdentity,
  type ProjectRecord,
} from "../domain/project-settings";

function identity({ id, name, path, usesGithub, defaultBranch }: ProjectIdentity): ProjectIdentity {
  return { id, name, path, usesGithub, defaultBranch };
}

export async function registerProject(
  input: ProjectRegistration,
  deps: ProjectDependencies,
): Promise<Result<ProjectRegistered, ProjectError>> {
  if (input.name !== undefined && !validProjectName(input.name)) return err(invalidProjectName);
  const resolved = await deps.resolvePath(input.path);
  if (resolved.isErr()) return err(resolved.error);
  const located = await deps.git.locate(resolved.value);
  if (located.isErr()) return err(located.error);
  const { path, repositoryPath } = located.value;
  if (path !== repositoryPath)
    return err({
      code: "invalid_input",
      message: `これは worktree です。リポジトリ本体のパス ${repositoryPath} を指定してください`,
    });
  const notes = path === resolved.value ? [] : ["リポジトリの最上位のパスで登録しました"];
  const restore = (previous: ProjectRecord): Result<ProjectRegistered, ProjectError> => {
    if (previous.removedAt === null) return err(projectPathTaken);
    if (deps.repository.nameTaken(previous.name, previous.id)) return err(projectNameTaken);
    deps.repository.update(previous.id, { removedAt: null });
    return ok({ project: identity(previous), restored: true, notes });
  };
  const existing = deps.transaction(() => {
    const previous = deps.repository.findPath(path);
    return previous ? restore(previous) : null;
  });
  if (existing !== null) {
    if (existing.isOk()) await deps.changed(existing.value.project.id);
    return existing;
  }
  const name = input.name ?? basename(path);
  if (!validProjectName(name)) return err(invalidProjectName);
  const github = await deps.github.inspect(await deps.git.origin(path), path);
  const branch = await deps.git.defaultBranch(path, github.available);
  if (branch.isErr()) return err(branch.error);
  const result = deps.transaction((): Result<ProjectRegistered, ProjectError> => {
    const concurrent = deps.repository.findPath(path);
    if (concurrent) return restore(concurrent);
    if (deps.repository.nameTaken(name)) return err(projectNameTaken);
    const project = {
      id: deps.id(),
      name,
      path,
      usesGithub: github.available,
      defaultBranch: branch.value,
    };
    deps.repository.create(project);
    return ok({
      project,
      restored: false,
      notes: github.reason ? [...notes, github.reason] : notes,
    });
  });
  if (result.isOk()) await deps.changed(result.value.project.id);
  return result;
}
