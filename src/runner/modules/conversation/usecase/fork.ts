import { err, type Result } from "neverthrow";
import { conflict, type ConversationRuntime, type DeliveryError } from "./runtime";
import { withConversationAdmission } from "./start";

export function fork(
  this: ConversationRuntime,
  id: string,
  input: { title: string; kind: "thread" },
  callerCancelled = () => false,
): Promise<Result<{ conversationId: string }, DeliveryError>> {
  return withConversationAdmission(this, id, "thread", callerCancelled, async (parent) => {
    if (parent.sessionId === null) return err(conflict());
    const forked = await this.options.agent.fork(parent.sessionId, { dir: parent.cwd });
    if (forked.isErr()) return err({ code: "internal", message: forked.error.message });
    return this.start({
      ...input,
      projectId: parent.projectId,
      cwd: parent.cwd,
      worktreeId: parent.worktreeId,
      issueId: parent.issueId,
      parentConversationId: id,
      sessionId: forked.value.sessionId,
      callerCancelled,
    });
  });
}
