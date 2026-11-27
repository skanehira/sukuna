import { unavailableRunnerError } from "../../../../shared/ipc";
import { err, ok } from "neverthrow";
import type { Conversation } from "../../conversation/domain/conversation-store";
import {
  InputRefused,
  type ConversationRuntime,
  type SendInput,
} from "../../conversation/usecase/runtime";
import type { PreparedDelivery } from "../../conversation/usecase/run-options";
import type { StageDesign, StageRepository } from "../domain/stage-ports";
import type { IssueNoticePort } from "../domain/ports";
import { firstInstruction } from "../domain/instructions";
import { moveStateWithin } from "./move-state";

export function createStageWorktreeRetry(
  repo: StageRepository,
  runtime: ConversationRuntime,
  design: StageDesign,
  notices: IssueNoticePort,
) {
  return async (
    c: Conversation,
    input: SendInput,
    by: "message" | "resume",
    cancelled = () => false,
  ) => {
    const id = c.issueId;
    const record = id && c.kind === "design" ? repo.read(id) : undefined;
    if (
      !id ||
      record?.issue.state !== "stopped" ||
      record.context.stoppedFrom !== "design" ||
      record.context.stoppedCause !== "worktree_failed"
    )
      return ok<PreparedDelivery>({ input });

    if (cancelled()) return err(unavailableRunnerError);
    const projectRun = runtime.store.reserveProjectRun(c.projectId);
    let reserved = false;
    try {
      const tree = await design.workspace({
        issueId: id,
        conversationId: c.id,
        prepareOnly: true,
        cancelled,
      });
      if (cancelled() || (tree.isErr() && tree.error.code === "runner_unavailable"))
        return err(unavailableRunnerError);
      if (tree.isErr())
        return err({ code: "worktree_failed" as const, message: tree.error.message });
      const first = firstInstruction("design", record.issue, record.project, tree.value);
      const changed =
        by === "resume"
          ? { ...input, origin: "flow" as const, text: first }
          : { ...input, origin: "developer" as const };
      let blockedByDependency = false;
      let latestNotice: Parameters<IssueNoticePort["publish"]>[0] | undefined;
      reserved = true;
      return ok<PreparedDelivery>({
        input: changed,
        prefix: by === "message" ? first : undefined,
        workspace: tree.value,
        release: () => projectRun.release(),
        before: () => {
          const now = repo.now();
          latestNotice = runtime.store.withWorktreeReservation((lease) =>
            repo.transaction((flow, data) => {
              const latest = flow.getIssue(id);
              if (!latest || latest.state !== "stopped" || latest.stopReason !== "failed") {
                throw new InputRefused({
                  code: "conflict",
                  message: "issue の状態が変わりました。",
                });
              }
              const context = flow.contextOf(latest);
              if (context.stoppedCause !== "worktree_failed") {
                throw new InputRefused({
                  code: "conflict",
                  message: "issue の状態が変わりました。",
                });
              }
              if (context.hasWithdrawnDependencies) {
                blockedByDependency = true;
                throw new InputRefused({
                  code: "conflict",
                  message: "issue の状態が変わりました。",
                });
              }
              const attached = design.attachWorkspace(id, c.id, tree.value, lease);
              if (attached.isErr())
                throw new InputRefused({ code: "conflict", message: attached.error.message });
              const moved = moveStateWithin(
                flow,
                { issueId: id, trigger: "agent_resumed", facts: { worktreeReady: true } },
                now,
              );
              if (moved.kind !== "moved")
                throw new InputRefused({
                  code: "conflict",
                  message: "issue の状態が変わりました。",
                });
              const start = data.append(
                id,
                "ai_started",
                { kind: "design", conversationId: c.id, reason: "worktree_retry" },
                now,
              );
              return { ...moved.notice, seq: start.seq };
            }, lease),
          );
        },
        rejected: () => {
          if (!blockedByDependency || cancelled()) return;
          const result = repo.transaction((flow) => {
            const latest = flow.getIssue(id);
            if (
              cancelled() ||
              latest?.state !== "stopped" ||
              latest.stopReason !== "failed" ||
              flow.contextOf(latest).stoppedCause !== "worktree_failed"
            )
              return;
            const moved = moveStateWithin(
              flow,
              { issueId: id, trigger: "dependency_withdrawn" },
              repo.now(),
            );
            if (cancelled()) throw new InputRefused(unavailableRunnerError);
            return moved;
          });
          if (result?.kind === "moved") notices.publish(result.notice);
        },
        committed: () => {
          if (latestNotice) notices.publish(latestNotice);
        },
      });
    } finally {
      if (!reserved) projectRun.release();
    }
  };
}
