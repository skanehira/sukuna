import { ConversationWorkspaceChanged } from "../domain/conversation-store";
import { WorktreeActivityBusy } from "../../../../shared/workspace/worktree-activity";
import { err, ok, type Result } from "neverthrow";
import type { ConversationRuntime, DeliveryError } from "./runtime";
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
): Promise<Result<{ conversationId: string }, DeliveryError>> {
  const id = this.options.id();
  try {
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
  } catch (error) {
    if (error instanceof WorktreeActivityBusy || error instanceof ConversationWorkspaceChanged)
      return err({ code: "conflict", message: error.message });
    throw error;
  }
  if (input.message) {
    const sent = await this.send(id, { text: input.message, images: [], origin: "developer" });
    if (sent.isErr()) return err(sent.error);
  }
  return ok({ conversationId: id });
}
