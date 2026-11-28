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
import { appendImplementationStage, moveStateWithin } from "./move-state";
import type { createImplementationStart } from "./start-implementation";

export function createStageWorktreeRetry(
  repo: StageRepository,
  runtime: ConversationRuntime,
  design: StageDesign,
  notices: IssueNoticePort,
  implementation: Pick<
    ReturnType<typeof createImplementationStart>,
    "prepare" | "attach" | "instruction"
  >,
) {
  return async (
    c: Conversation,
    input: SendInput,
    by: "message" | "resume",
    cancelled = () => false,
  ) => {
    const id = c.issueId;
    const stage = c.kind === "impl" ? "implementing" : c.kind === "design" ? "design" : null;
    const record = id && stage ? repo.read(id) : undefined;
    if (
      !id ||
      record?.issue.state !== "stopped" ||
      record.context.stoppedFrom !== stage ||
      record.context.stoppedCause !== "worktree_failed"
    )
      return ok<PreparedDelivery>({ input });

    if (cancelled()) return err(unavailableRunnerError);
    const projectRun = runtime.store.reserveProjectRun(c.projectId);
    let reserved = false;
    try {
      const workspace = async () => {
        if (c.kind === "impl") {
          const result = await implementation.prepare(id, c.id, cancelled);
          if (result.isErr()) return err(result.error);
          const tree = result.value;
          return ok({
            tree,
            first: await implementation.instruction(id, tree),
            attach: (_reservation: Parameters<StageDesign["attachWorkspace"]>[3]) =>
              implementation.attach(c.id, tree)
                ? ok(undefined)
                : err({ message: "実装の作業場所が変わりました。" }),
          });
        }
        const result = await design.workspace({
          issueId: id,
          conversationId: c.id,
          prepareOnly: true,
          cancelled,
        });
        if (result.isErr()) return err(result.error);
        const tree = result.value;
        return ok({
          tree,
          first: firstInstruction("design", record.issue, record.project, tree),
          attach: (reservation: Parameters<StageDesign["attachWorkspace"]>[3]) =>
            design.attachWorkspace(id, c.id, tree, reservation),
        });
      };
      const prepared = await workspace();
      if (cancelled() || (prepared.isErr() && prepared.error.code === "runner_unavailable"))
        return err(unavailableRunnerError);
      if (prepared.isErr())
        return err({ code: "worktree_failed" as const, message: prepared.error.message });
      const { first, tree, attach } = prepared.value;
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
        workspace: tree,
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
              if (context.stoppedCause !== "worktree_failed" || context.stoppedFrom !== stage) {
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
              const attached = attach(lease);
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
              const state = c.kind === "impl" ? appendImplementationStage(moved, data, now) : moved;
              const start = data.append(
                id,
                "ai_started",
                { kind: c.kind, conversationId: c.id, reason: "worktree_retry" },
                now,
              );
              return { ...state.notice, seq: start.seq };
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
