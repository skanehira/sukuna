import type { Result } from "neverthrow";
import type { ProjectPatch, ProjectSettings } from "../../../../shared/api/project";

export type ProjectError = {
  code:
    | "invalid_input"
    | "not_a_repository"
    | "conflict"
    | "not_found"
    | "internal"
    | "runner_unavailable";
  message: string;
};
export const projectNotFound: ProjectError = {
  code: "not_found",
  message: "プロジェクトが見つかりません。",
};
export const projectPathTaken: ProjectError = {
  code: "conflict",
  message: "このパスはすでに登録されています。",
};
export const projectNameTaken: ProjectError = {
  code: "conflict",
  message: "この名前のプロジェクトがすでにあります。",
};
export const invalidProjectName: ProjectError = {
  code: "invalid_input",
  message: "名前は空白と / を含まない 1〜40 字で指定してください。",
};

export function validProjectName(name: string): boolean {
  const length = Array.from(name).length;
  return length >= 1 && length <= 40 && !/[\s/\p{Cc}]/u.test(name);
}

export type ProjectRecord = Omit<ProjectSettings, "stopTargetCount" | "globalFlowPaused"> & {
  removedAt: number | null;
};
export type ProjectIdentity = Pick<
  ProjectRecord,
  "id" | "name" | "path" | "usesGithub" | "defaultBranch"
>;
export type ProjectGit = {
  locate(cwd: string): Promise<Result<{ path: string; repositoryPath: string }, ProjectError>>;
  defaultBranch(cwd: string, usesGithub: boolean): Promise<Result<string, ProjectError>>;
  hasBranch(cwd: string, branch: string, usesGithub: boolean): Promise<boolean>;
  origin(cwd: string): Promise<string | null>;
};
export type ProjectRepository = {
  find(id: string): ProjectRecord | undefined;
  findPath(path: string): ProjectRecord | undefined;
  nameTaken(name: string, exceptId?: string): boolean;
  create(project: ProjectIdentity): void;
  update(id: string, patch: ProjectPatch & { removedAt?: number | null }): void;
  settings(project: ProjectRecord): ProjectSettings;
};
export type ProjectDependencies = {
  repository: ProjectRepository;
  transaction<T>(operation: () => T): T;
  resolvePath(input: string): Promise<Result<string, ProjectError>>;
  git: ProjectGit;
  github: {
    inspect(origin: string | null, cwd: string): Promise<{ available: boolean; reason?: string }>;
  };
  now(): number;
  id(): string;
  stop(projectId: string): Promise<Result<string[], ProjectError>>;
  reserve(projectId: string): Result<{ release(): void }, ProjectError>;
  changed(projectId: string): Promise<void>;
};
