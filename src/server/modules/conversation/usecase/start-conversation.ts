import { err, ok } from "neverthrow";
import { z } from "zod";
import type { ConversationWorkspaceChoice } from "../../../../shared/conversation/api";
import type {
  ConversationDependencies,
  ConversationError,
  ConversationWorktrees,
} from "../domain/ports";

export async function startConversation(
  { projectId, workspace }: { projectId: string; workspace: ConversationWorkspaceChoice },
  deps: ConversationDependencies,
  worktrees?: ConversationWorktrees,
) {
  const project = deps.repository.project(projectId);
  if (!project)
    return err<never, ConversationError>({
      code: "not_found",
      message: "プロジェクトが見つかりません。",
    });
  let cwd = project.path;
  let worktreeId: string | undefined;
  let notice: string | null = null;
  if (workspace.kind !== "project") {
    if (!worktrees)
      return err<never, ConversationError>({
        code: "internal",
        message: "worktree を読み込めません。",
      });
    if (workspace.kind === "new_worktree") {
      const created = await worktrees.create(projectId, workspace.name);
      if (created.isErr()) return err(created.error);
      ({ id: worktreeId, path: cwd, notice } = created.value);
    } else {
      const found = await worktrees.find(projectId, workspace.worktreeId);
      if (found.isErr()) return err(found.error);
      ({ id: worktreeId, path: cwd } = found.value);
    }
  }
  const result = await deps.runner.call("POST", "/conversations", {
    project_id: projectId,
    kind: "chat",
    cwd,
    ...(worktreeId === undefined ? {} : { worktree_id: worktreeId }),
    title: "新しい会話",
  });
  if (result.isErr()) return err(result.error);
  if (result.value.status >= 400) return ok(result.value);
  const body = z.object({ conversation_id: z.string() }).parse(result.value.body);
  if (notice) deps.notice?.(body.conversation_id, notice);
  return ok({
    status: 201,
    body: { conversation: deps.repository.conversation(body.conversation_id) },
  });
}
