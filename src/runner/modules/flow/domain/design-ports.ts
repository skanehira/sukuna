import type { Result } from "neverthrow";
import type { DesignError, DesignSubmission } from "../../../../shared/api/design";
import type { DesignRejectionDraft } from "../../../../shared/ipc";
import type { DesignProject, DesignRecord } from "../../../../shared/design/records";
import type {
  WorktreeActivity,
  WorktreeActivityReservation,
} from "../../../../shared/workspace/worktree-activity";
import type { IssueNotice, IssueNoticePort } from "./ports";
import type { TransitionTrigger } from "./transition";

export type DesignWorktree = { id: string; path: string; branch: string };
export type DesignGitEntry = {
  path: string;
  head: string;
  branch: string | null;
  locked: string | null;
};
type GitFailure = { message: string };
type GitResult<T> = Promise<Result<T, GitFailure>>;

export interface DesignWorkspaceGit {
  list(cwd: string): GitResult<DesignGitEntry[]>;
  exists(path: string): GitResult<boolean>;
  branchExists(cwd: string, branch: string): GitResult<boolean>;
  exclude(cwd: string): GitResult<void>;
  fetch(cwd: string, branch: string): GitResult<void>;
  add(cwd: string, path: string, branch: string, start: string): GitResult<void>;
  status(
    project: DesignProject,
    worktree: DesignGitEntry,
  ): GitResult<{
    uncommittedCount: number;
    uncommittedSample: string[];
    unpushedCount: number;
    head: string;
    branch: string | null;
    missing: boolean;
  }>;
  mergedPrHeads(cwd: string, urls: string[]): Promise<string[]>;
}

export interface DesignGit {
  head(cwd: string, ref: string): GitResult<string>;
  range(
    project: DesignProject,
    branch: string,
  ): GitResult<Pick<DesignSubmission, "baseCommit" | "headCommit">>;
  hasChanges(cwd: string, base: string, head: string): GitResult<boolean>;
  protectHead(cwd: string, branch: string, head: string): GitResult<{ release(): Promise<void> }>;
  reflect(
    project: DesignProject,
    tree: DesignWorktree,
    approved: Pick<DesignSubmission, "baseCommit" | "headCommit">,
  ): GitResult<string>;
  pushBranch(tree: DesignWorktree, head: string): GitResult<void>;
  canonical(path: string): Promise<string>;
}

export interface DesignGithub {
  create(project: DesignProject, branch: string, title: string, body: string): GitResult<string>;
  view(
    project: DesignProject,
    url: string,
  ): GitResult<{ state: string; mergeCommit: string | null }>;
}

export interface DesignRepository {
  read(id: string): DesignRecord | null;
  findTree(
    issueId: string,
    projectId: string,
    number: number,
  ): (DesignWorktree & { branchCreated: boolean }) | null;
  pathTaken(projectId: string, path: string): boolean;
  saveTree(record: DesignRecord, tree: DesignWorktree): void;
  abandonTree(id: string, now: number): void;
  attachTree(record: DesignRecord, conversationId: string, tree: DesignWorktree): boolean;
  detachTree(record: DesignRecord, tree: DesignWorktree, now: number): void;
  clearDraft(id: string, sent: DesignRejectionDraft, now: number): boolean;
  append(record: DesignRecord, type: string, payload: unknown, now: number): IssueNotice;
  move(
    record: DesignRecord,
    trigger: TransitionTrigger,
    now: number,
    detail?: string,
    worktreeReady?: boolean,
  ): boolean;
}

export type DesignFlowDependencies = {
  repo: DesignRepository;
  transaction<T>(
    action: (repo: DesignRepository) => T,
    reservation?: WorktreeActivityReservation,
  ): T;
  activity: WorktreeActivity;
  workspace: DesignWorkspaceGit;
  git: DesignGit;
  gh: DesignGithub;
  clock: { now(): number; id(): string };
  notices: IssueNoticePort;
  alert(issueId: string, message: string): void;
  log(error: unknown): void;
};

export function designInternal(message: string): DesignError {
  return { code: "internal", message };
}
