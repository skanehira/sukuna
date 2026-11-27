import { err, ok } from "neverthrow";
import {
  missingConversation,
  type ConversationDependencies,
  type ConversationError,
  type ConversationWorktrees,
} from "../domain/ports";

const unknownWorkspaceSwitch: ConversationError = {
  code: "internal",
  message: "作業場所の切り替え結果を確かめられませんでした。会話を読み直してください。",
};

export async function switchWorkspace(
  id: string,
  worktreeId: string | null,
  deps: ConversationDependencies,
  worktrees?: ConversationWorktrees,
) {
  const conversation = deps.repository.conversation(id);
  if (!conversation) return err(missingConversation);
  const project = deps.repository.project(conversation.projectId);
  if (!project)
    return err<never, ConversationError>({
      code: "not_found",
      message: "プロジェクトが見つかりません。",
    });
  let cwd = project.path;
  if (worktreeId !== null) {
    if (!worktrees)
      return err<never, ConversationError>({
        code: "internal",
        message: "worktree を読み込めません。",
      });
    const found = await worktrees.find(project.id, worktreeId);
    if (found.isErr()) return err(found.error);
    cwd = found.value.path;
  }
  const attempt = deps.workspaceSwitchAttempt();
  const result = await deps.runner.call(
    "POST",
    `/conversations/${encodeURIComponent(id)}/workspace`,
    {
      cwd,
      worktree_id: worktreeId,
      attempt,
    },
  );
  if (result.isOk() && result.value.status >= 400 && result.value.status !== 503)
    return ok(result.value);
  const interrupted = result.isErr() || result.value.status === 503;
  const { repository } = deps;
  const readReceipt = () => repository.workspaceSwitchReceipt(attempt, deps.now());
  try {
    let receipt = readReceipt();
    if (!receipt && interrupted) {
      receipt = repository.transaction(() => {
        const stored = readReceipt();
        if (stored) return stored;
        repository.cancelWorkspaceSwitch(id, attempt, deps.now());
        return { conversationId: id, conversation: null };
      });
    }
    if (!receipt || receipt.conversationId !== id) return err(unknownWorkspaceSwitch);
    if (receipt.conversation)
      return ok({ status: 200, body: { conversation: receipt.conversation } });
    if (!interrupted) return err(unknownWorkspaceSwitch);
    return result.isErr() ? err(result.error) : ok(result.value);
  } catch {
    return err(unknownWorkspaceSwitch);
  }
}
