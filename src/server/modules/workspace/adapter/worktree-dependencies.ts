import { err, Result } from "neverthrow";
import { ulid } from "ulid";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { createGhRunner, type GhRunner } from "../../../../shared/gh/gh-runner";
import type { WorktreeDependencies, WorktreeError } from "../domain/worktree-ports";
import { createGitCli, createWorktreeGit, type GitRunner } from "./git-cli";
import { createWorktreeRemovalStorage } from "./worktree-removal-storage";
import { createWorktreeRepository } from "./worktree-repository";

export function createWorktreeDependencies(
  database: () => OpenedDatabase["db"],
  options: {
    git?: GitRunner;
    gh?: GhRunner;
    now?: () => number;
    id?: () => string;
  } = {},
): WorktreeDependencies {
  const git = options.git ?? createGitCli();
  return {
    unitOfWork: {
      run(operation) {
        let failure: WorktreeError | undefined;
        const result = Result.fromThrowable(
          () =>
            database().transaction((tx) => {
              const result = operation(createWorktreeRepository(() => tx));
              if (result.isErr()) {
                failure = result.error;
                tx.rollback();
              }
              return result;
            }),
          (): WorktreeError =>
            failure ?? { code: "internal", message: "worktree の記録を読み書きできませんでした" },
        )();
        return result.isErr() ? err(result.error) : result.value;
      },
    },
    removals: createWorktreeRemovalStorage(git),
    repository: createWorktreeRepository(database),
    git: createWorktreeGit(git, options.gh ?? createGhRunner(process.env.SUKUNA_GH ?? null)),
    now: options.now ?? (() => Date.now()),
    id: options.id ?? ulid,
  };
}
