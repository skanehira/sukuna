import type { WorktreeActivity } from "../../../../shared/workspace/worktree-activity";
import type { Result } from "neverthrow";
import type { WorktreeItem } from "../../../../shared/api/worktree";
import type { WorktreeConflict } from "../../../../shared/workspace/worktree-safety";
import type { TerminalDependencies } from "./terminal-ports";

export type WorktreeError = {
  code: "invalid_input" | "not_found" | "conflict" | "internal" | "worktree_failed";
  message: string;
  details?: WorktreeConflict["details"];
};
export type WorktreeProject = {
  id: string;
  path: string;
  defaultBranch: string;
  usesGithub: boolean;
};
export type WorktreeRecord = {
  id: string;
  projectId: string;
  path: string;
  branch: string;
  branchCreated: boolean;
  origin: "user" | "flow";
  issueId: string | null;
  removedAt?: number | null;
};
export type WorktreeConversation = WorktreeItem["conversations"][number] & {
  cwd: string;
  closedAt: number | null;
};
export type WorktreeIssue = NonNullable<WorktreeItem["issue"]> & { prUrls: string[] };
export type WorktreeSnapshot = {
  project: WorktreeProject;
  worktrees: WorktreeRecord[];
  conversations: WorktreeConversation[];
  issues: WorktreeIssue[];
};
export interface WorktreeRepositoryPort {
  snapshot(projectId: string): Result<WorktreeSnapshot, WorktreeError>;
  find(id: string, includeRemoved?: boolean): Result<WorktreeRecord, WorktreeError>;
  discover(record: WorktreeRecord): Result<WorktreeRecord, WorktreeError>;
  reserve(record: WorktreeRecord): Result<void, WorktreeError>;
  abandon(id: string, now: number): Result<void, WorktreeError>;
  remove(
    record: WorktreeRecord,
    project: WorktreeProject,
    now: number,
  ): Result<string[], WorktreeError>;
}
export type GitWorktree = {
  path: string;
  branch: string | null;
  head: string;
  locked: string | null;
};
export type WorktreeStatus = {
  uncommittedCount: number;
  uncommittedSample: string[];
  unpushedCount: number;
  missing: boolean;
  head: string;
  branch: string | null;
};
export interface WorktreeGitPort {
  list(cwd: string): Promise<Result<GitWorktree[], WorktreeError>>;
  status(
    project: WorktreeProject,
    worktree: GitWorktree,
  ): Promise<Result<WorktreeStatus, WorktreeError>>;
  exists(path: string): Promise<Result<boolean, WorktreeError>>;
  branchExists(cwd: string, branch: string): Promise<Result<boolean, WorktreeError>>;
  exclude(cwd: string): Promise<Result<void, WorktreeError>>;
  fetch(cwd: string, branch: string): Promise<Result<void, WorktreeError>>;
  add(
    cwd: string,
    path: string,
    branch: string,
    start: string | null,
  ): Promise<Result<void, WorktreeError>>;
  remove(cwd: string, path: string): Promise<Result<void, WorktreeError>>;
  prune(cwd: string): Promise<Result<void, WorktreeError>>;
  protect(
    project: WorktreeProject,
    current: { path: string; head: string; branch: string | null } | null,
  ): Promise<Result<{ release(): Promise<void> }, WorktreeError>>;
  mergedPrHeads(cwd: string, urls: string[]): Promise<string[]>;
}
export interface WorktreeUnitOfWorkPort {
  run<T>(
    operation: (repository: WorktreeRepositoryPort) => Result<T, WorktreeError>,
  ): Result<T, WorktreeError>;
}
export type WorktreeRemovalPlan = {
  worktreeRemoved: boolean;
  identity: string | null;
};
export interface WorktreeRemovalStoragePort {
  load(
    project: WorktreeProject,
    id: string,
  ): Promise<Result<WorktreeRemovalPlan | null, WorktreeError>>;
  save(
    project: WorktreeProject,
    id: string,
    plan: WorktreeRemovalPlan,
  ): Promise<Result<void, WorktreeError>>;
  clear(project: WorktreeProject, id: string): Promise<Result<void, WorktreeError>>;
  identity(project: WorktreeProject, path: string): Promise<Result<string | null, WorktreeError>>;
}
export type WorktreeDependencies = {
  repository: WorktreeRepositoryPort;
  activity: Pick<WorktreeActivity, "acquire">;
  unitOfWork: WorktreeUnitOfWorkPort;
  removals: WorktreeRemovalStoragePort;
  git: WorktreeGitPort;
  now: () => number;
  id: () => string;
  terminals?: TerminalDependencies;
};
export const WORKTREE_CONFLICT: WorktreeError = {
  code: "conflict",
  message: "同じ名前の worktree、フォルダ、または使用中のブランチがあります",
};

export const WORKTREE_CHANGED: WorktreeError = {
  code: "conflict",
  message:
    "worktree またはブランチの状態が変わりました。一覧を取り直してから、もう一度消してください",
};
