import { stat } from "node:fs/promises";
import { err, ok } from "neverthrow";
import type { WorktreeDependencies } from "../../workspace/domain/worktree-ports";
import { createWorktree } from "../../workspace/usecase/create-worktree";
import type { ConversationError, ConversationWorktrees } from "../domain/ports";

const missingWorktree: ConversationError = { code: "not_found", message: "worktree がありません" };

export function createConversationWorktrees(deps: WorktreeDependencies): ConversationWorktrees {
  return {
    create: (projectId, name) => createWorktree(projectId, name, deps),
    async find(projectId, id) {
      const found = deps.repository.find(id);
      if (found.isErr()) return err(found.error);
      const { path } = found.value;
      if (found.value.projectId !== projectId) return err(missingWorktree);
      try {
        return (await stat(path)).isDirectory() ? ok({ id, path }) : err(missingWorktree);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR"].includes(String(error.code))
        )
          return err(missingWorktree);
        return err({ code: "internal", message: "worktree のフォルダを確認できませんでした" });
      }
    },
  };
}
