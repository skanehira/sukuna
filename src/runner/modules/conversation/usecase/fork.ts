import { err, type Result } from "neverthrow";
import type { ConversationRuntime, DeliveryError } from "./runtime";
import { conflict } from "./runtime";

export async function fork(
  this: ConversationRuntime,
  id: string,
  input: { title: string; kind: "thread" },
): Promise<Result<{ conversationId: string }, DeliveryError>> {
  const c = this.store.get(id);
  if (!c) return err({ code: "not_found", message: "会話が見つかりません。" });
  if (c.sessionId === null) return err(conflict());
  const fork = await this.options.agent.fork(c.sessionId, { dir: c.cwd });
  if (fork.isErr()) return err({ code: "internal", message: fork.error.message });
  return this.start({
    ...input,
    projectId: c.projectId,
    cwd: c.cwd,
    worktreeId: c.worktreeId,
    issueId: c.issueId,
    parentConversationId: id,
    sessionId: fork.value.sessionId,
  });
}
