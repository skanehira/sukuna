import { ConversationWorkspaceChanged, ProjectRunBlocked } from "../domain/conversation-store";
import { WorktreeActivityBusy } from "../../../../shared/workspace/worktree-activity";
import { err, ok, type Result } from "neverthrow";
import {
  conflict,
  type ConversationRuntime,
  type DeliveryError,
  type InputAcceptance,
  type SendInput,
} from "./runtime";
import type {
  Conversation,
  ConversationKind,
  ProjectRunReservation,
} from "../domain/conversation-store";
const missingParent = { code: "not_found" as const, message: "元の会話が見つかりません。" };
const expired = {
  code: "runner_unavailable" as const,
  message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
};
class StartCancelled extends Error {}

export function withConversationAdmission<T>(
  runtime: ConversationRuntime,
  id: string,
  kind: "thread" | "stock",
  callerCancelled: () => boolean,
  run: (parent: Conversation) => Promise<Result<T, DeliveryError>>,
): Promise<Result<T, DeliveryError>> {
  const closedAt = runtime.store.get(id)?.closedAt;
  const reserving = runtime.releases.has(id);
  return runtime.serial(id, async () => {
    const parent = runtime.store.get(id);
    if (callerCancelled() && (kind === "thread" || parent !== null)) return err(expired);
    if (!parent)
      return err(
        kind === "stock" ? { code: "not_found", message: "会話が見つかりません。" } : missingParent,
      );
    if (parent.closedAt !== null && (reserving || parent.closedAt !== closedAt))
      return err(conflict("元の会話が閉じました。読み直してから操作してください。"));
    if (kind === "stock" && reserving)
      return err(conflict("会話の終了処理中です。読み直してから操作してください。"));
    return run(parent);
  });
}

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
    callerCancelled?: () => boolean;
  },
  firstInput?: { message: SendInput; acceptance(id: string): InputAcceptance },
): Promise<Result<{ conversationId: string }, DeliveryError>> {
  const id = this.options.id();
  const conversation: Conversation = {
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
  };
  let projectRun: ProjectRunReservation | undefined;
  try {
    projectRun = this.store.reserveProjectRun(input.projectId);
    if (firstInput) {
      const delivered = await this.deliver(id, firstInput.message, firstInput.acceptance(id), {
        newConversation: conversation,
        includeQueued: false,
        projectRun,
      });
      return delivered.map(() => ({ conversationId: id }));
    }
    const created = this.store.transaction(() => {
      if (input.callerCancelled?.()) throw new StartCancelled();
      const parent = input.parentConversationId;
      if (input.kind === "thread" && parent && !this.store.get(parent)) return false;
      this.store.create(conversation);
      if (input.callerCancelled?.()) throw new StartCancelled();
      return true;
    });
    if (!created) return err(missingParent);
    if (input.message) {
      const sent = await this.send(
        id,
        { text: input.message, images: [], origin: "developer" },
        undefined,
        projectRun,
      );
      if (sent.isErr()) return err(sent.error);
    }
    return ok({ conversationId: id });
  } catch (error) {
    if (error instanceof StartCancelled) return err(expired);
    if (
      error instanceof WorktreeActivityBusy ||
      error instanceof ConversationWorkspaceChanged ||
      error instanceof ProjectRunBlocked
    )
      return err({ code: "conflict", message: error.message });
    throw error;
  } finally {
    projectRun?.release();
  }
}
