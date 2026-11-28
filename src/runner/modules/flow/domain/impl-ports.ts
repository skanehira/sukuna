import type { LockObserver, RecordedGitLock } from "../../../../shared/workspace/recorded-lock";
import type { Result } from "neverthrow";
import type { DesignWorkspaceGit } from "./design-ports";
import type { DesignProject } from "../../../../shared/design/records";

type GitError = { message: string };
import type { WorktreeActivity } from "../../../../shared/workspace/worktree-activity";

export type ImplementationLock = RecordedGitLock;
export type ImplementationIdentity = { registration: string; directory: string };
export type ImplementationTree = {
  id: string;
  projectId: string;
  issueId: string;
  path: string;
  branch: string;
  portSlot: number;
  identity: ImplementationIdentity | null;
  cleanupPath: string | null;
  cleanupDetached: boolean;
  cleanupLocks: ImplementationLock[];
};

export interface ImplementationGit extends DesignWorkspaceGit {
  createOwned(
    cwd: string,
    path: string,
    branch: string,
    start: string,
  ): Promise<Result<ImplementationIdentity, GitError>>;
  owns(path: string, identity: ImplementationIdentity | null): boolean;
  registrationExists(identity: ImplementationIdentity): boolean;
  removeOwned(
    cwd: string,
    path: string,
    identity: ImplementationIdentity,
    cleanupPath: string | null,
    expected: { head: string; branch: string },
    planned: (path: string, detached: boolean) => void,
    observer: LockObserver,
  ): Promise<Result<void, GitError & { retainedPath?: string }>>;
  recoverLocks(tree: ImplementationTree): void;
  recoverOwned(
    project: DesignProject,
    tree: ImplementationTree,
  ): Promise<{ state: "restored" | "removed" | "kept"; path?: string }>;
  protect(
    project: DesignProject,
    current: { path: string; head: string; branch: string },
    observer: LockObserver,
  ): Promise<Result<{ release(): Promise<void>; files?: ImplementationLock[] }, GitError>>;
  directoryKey(path: string): Promise<string | null>;
  canonical(path: string): Promise<string>;
  include(
    cwd: string,
    target: string,
    identity: ImplementationIdentity,
  ): Promise<Result<void, GitError>>;
  headAt(cwd: string, ref: string): Promise<Result<string, GitError>>;
  comparisonBase(cwd: string, head: string, baseTip: string | null): Promise<string | null>;
  sameChange(
    cwd: string,
    previous: { base: string; head: string },
    current: { base: string; head: string },
  ): Promise<boolean>;
  protectTip(
    cwd: string,
    branch: string,
    expected: string,
    observer: LockObserver,
  ): Promise<Result<{ release(): Promise<void> }, GitError>>;
  origin(cwd: string): Promise<Result<string, GitError>>;
  contains(
    cwd: string,
    tip: string,
    commits: readonly string[],
  ): Promise<Result<boolean, GitError>>;
}

export interface ImplementationGithub {
  target(cwd: string, origin: string): Promise<Result<string, { message: string }>>;
  view(
    cwd: string,
    target: { repository: string; base: string; branch: string },
    url: string,
  ): Promise<
    Result<
      {
        state: "OPEN" | "MERGED" | "CLOSED";
        url: string;
        head: string;
        baseTip: string | null;
        merge: string | null;
      },
      { message: string }
    >
  >;
}

export interface ImplementationTrees {
  activity: WorktreeActivity;
  list(projectId: string): ImplementationTree[];
  reserve(
    tree: Omit<
      ImplementationTree,
      "portSlot" | "identity" | "cleanupPath" | "cleanupDetached" | "cleanupLocks"
    >,
  ): ImplementationTree;
  bindIdentity(id: string, identity: ImplementationIdentity): void;
  planCleanup(id: string, path: string | null, detached: boolean): void;
  lockObserver(id: string): LockObserver;
  clearLocks(id: string): void;
  pending(): ImplementationTree[];
  resetLocation(tree: ImplementationTree, cwd: string): void;
  abandon(id: string, now: number): void;
  attach(conversationId: string, tree: ImplementationTree): boolean;
  detach(tree: ImplementationTree, projectPath: string, now: number): boolean;
}

export interface ImplementationTerminalCleanup {
  close(
    worktreeId: string,
    path: string,
    directoryKey: string,
  ): Promise<"closed" | "deferred" | "reconnected">;
}
