import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, OperationError } from "./runtime";
import type { ConversationKind } from "../domain/conversation-store";
export async function start(
  this: ConversationRuntime,
  input: {
    projectId: string;
    kind: ConversationKind;
    cwd: string;
    title: string;
    message?: string;
    issueId?: string | null;
    worktreeId?: string | null;
    parentConversationId?: string | null;
    sessionId?: string;
  },
): Promise<Result<{ conversationId: string }, OperationError>> {
  const id = this.options.id();
  this.store.transaction(() =>
    this.store.create({
      id,
      projectId: input.projectId,
      kind: input.kind,
      issueId: input.issueId ?? null,
      parentConversationId: input.parentConversationId ?? null,
      title: input.title,
      sessionId: input.sessionId ?? null,
      cwd: input.cwd,
      worktreeId: input.worktreeId ?? null,
      runState: "idle",
      stopReason: null,
      resetsAt: null,
      lastSeq: 0,
      lastActivityAt: null,
      closedAt: null,
    }),
  );
  if (input.message) {
    const sent = await this.send(id, { text: input.message, images: [], origin: "developer" });
    if (sent.isErr()) return err(sent.error);
  }
  return ok({ conversationId: id });
}
