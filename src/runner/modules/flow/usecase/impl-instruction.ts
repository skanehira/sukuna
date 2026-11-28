import { err, ok } from "neverthrow";
import { unavailableRunnerError } from "../../../../shared/ipc";
import type { Conversation } from "../../conversation/domain/conversation-store";
import {
  InputRefused,
  type ConversationRuntime,
  type SendInput,
} from "../../conversation/usecase/runtime";
import type { PreparedDelivery } from "../../conversation/usecase/run-options";
import { hasFlowHistory } from "../domain/evaluate";
import {
  implementationFixInstruction,
  pendingImplementationFix,
  issueHistoryPoint,
} from "../domain/impl-history";
import type { IssueNoticePort } from "../domain/ports";
import type { StageRepository, StageSnapshot } from "../domain/stage-ports";
import { appendImplementationStage, moveStateWithin } from "./move-state";
import type { createImplementationStart } from "./start-implementation";

const conflict = { code: "conflict" as const, message: "実装の作業条件が変わりました。" };

function awaitsRevision({ issue, context }: StageSnapshot) {
  return (
    issue.state === "stopped" &&
    (issue.stopReason === "merge_confirm" || issue.stopReason === "ci_failed") &&
    (!context.stoppedFrom || context.stoppedFrom === "implementing")
  );
}

export function createImplementationInstructionDelivery(
  repo: StageRepository,
  runtime: ConversationRuntime,
  implementation: Pick<ReturnType<typeof createImplementationStart>, "prepare" | "attach">,
  notices: IssueNoticePort,
  schedule: (projectId: string) => void,
) {
  function moveStopped(
    record: StageSnapshot,
    conversationId: string,
    input: SendInput,
    cancelled: () => boolean,
    queuedIds: readonly string[] = [],
  ) {
    const { issue, events } = record;
    const sameState = () => issueHistoryPoint(repo.events(issue.id)) === issueHistoryPoint(events);
    let notice: Parameters<IssueNoticePort["publish"]>[0] | undefined;
    let blocked = false;
    return ok<PreparedDelivery>({
      input,
      before: () => {
        notice = runtime.store.withWorktreeReservation((lease) =>
          repo.transaction((flow, data) => {
            if (!sameState()) throw new InputRefused(conflict);
            const now = repo.now();
            const moved = moveStateWithin(
              flow,
              { issueId: issue.id, trigger: "impl_instruction" },
              now,
            );
            if (moved.kind !== "moved") throw new InputRefused(conflict);
            if (flow.getIssue(issue.id)?.state !== "implementing") {
              blocked = true;
              throw new InputRefused(conflict);
            }
            const conversation = runtime.store.get(conversationId);
            if (!conversation) throw new InputRefused(conflict);
            data.append(
              issue.id,
              "implementation_revision_requested",
              { conversationId, afterTurnSeq: conversation.lastSeq, queuedIds },
              now,
            );
            return appendImplementationStage(moved, data, now).notice;
          }, lease),
        );
      },
      committed: () => {
        if (notice) notices.publish(notice);
      },
      rejected: () => {
        if (!blocked || cancelled()) return;
        const moved = repo.transaction((flow) => {
          if (!sameState() || cancelled()) return;
          return moveStateWithin(
            flow,
            { issueId: issue.id, trigger: "dependency_withdrawn" },
            repo.now(),
          );
        });
        if (moved?.kind === "moved") notices.publish(moved.notice);
      },
    });
  }

  function startFix(
    record: StageSnapshot,
    trigger: "reopened_for_fix" | "agent_resumed",
    cancelled: () => boolean,
  ) {
    const { issue, project } = record;
    const previousPrUrl = project.usesGithub ? issue.prUrl : null;
    const result = repo.transaction((flow, data) => {
      if (cancelled() || runtime.closing) return err(unavailableRunnerError);
      const latest = flow.getIssue(issue.id);
      if (
        latest?.state !== issue.state ||
        issueHistoryPoint(repo.events(issue.id)) !== issueHistoryPoint(record.events)
      )
        return err(conflict);
      const now = repo.now();
      const moved = moveStateWithin(flow, { issueId: issue.id, trigger }, now);
      if (moved.kind !== "moved") return err(conflict);
      if (flow.getIssue(issue.id)?.state !== "implementing") throw new InputRefused(conflict);
      if (trigger === "reopened_for_fix") {
        data.append(issue.id, "reopened_for_fix", { previousPrUrl }, now);
        data.update(issue.id, { prUrl: null });
      }
      const stage = appendImplementationStage(moved, data, now);
      if (cancelled() || runtime.closing) throw new InputRefused(unavailableRunnerError);
      return ok(stage.notice);
    });
    if (result.isOk()) {
      notices.publish(result.value);
      schedule(project.id);
    }
    return result;
  }

  function implementationRecord(c: Conversation) {
    const record = c.kind === "impl" && c.issueId ? repo.read(c.issueId) : undefined;
    return record && hasFlowHistory(record.events) ? record : undefined;
  }

  const prepare = async (
    c: Conversation,
    input: SendInput,
    by: "message" | "resume",
    cancelled = () => false,
  ) => {
    const initial = implementationRecord(c);
    if (!initial) return undefined;
    const { issue, project, context } = initial;
    const id = issue.id;
    const pending = pendingImplementationFix(initial.events);
    const retryOpening =
      pending &&
      issue.state === "stopped" &&
      issue.stopReason === "failed" &&
      context.stoppedFrom === "implementing" &&
      context.stoppedCause === "agent_failed";
    if (by === "resume" && !retryOpening) return undefined;
    if (awaitsRevision(initial)) return moveStopped(initial, c.id, input, cancelled);
    if (!retryOpening && issue.state !== "done" && (issue.state !== "implementing" || !pending))
      return undefined;
    if (cancelled() || runtime.closing) return err(unavailableRunnerError);
    if (project.removedAt !== null || context.hasWithdrawnDependencies) return err(conflict);
    if (by === "message") {
      const readable = runtime.readDeliveryInput(c.id, input);
      if (readable.isErr()) return err(readable.error);
    }
    const run = runtime.store.reserveProjectRun(c.projectId);
    let accepted = false;
    try {
      if (issue.state === "done" || retryOpening) {
        const reopened = startFix(
          initial,
          retryOpening ? "agent_resumed" : "reopened_for_fix",
          cancelled,
        );
        if (reopened.isErr()) return err(reopened.error);
      }
      const record = repo.read(id);
      const fix = record && pendingImplementationFix(record.events);
      if (!fix) return err(conflict);
      const prepared = await implementation.prepare(id, c.id, cancelled);
      if (prepared.isErr()) return err(prepared.error);
      if (cancelled() || runtime.closing) return err(unavailableRunnerError);
      const tree = prepared.value;
      const first = implementationFixInstruction(fix);
      let notice: Parameters<IssueNoticePort["publish"]>[0] | undefined;
      accepted = true;
      return ok<PreparedDelivery>({
        input: by === "resume" ? { ...input, text: first, origin: "flow" } : input,
        prefix: by === "message" ? first : undefined,
        workspace: tree,
        release: () => run.release(),
        before: () => {
          notice = runtime.store.withWorktreeReservation((lease) =>
            repo.transaction((flow, data) => {
              const latest = flow.getIssue(id);
              const current = runtime.store.get(c.id);
              if (
                latest?.state !== "implementing" ||
                flow.contextOf(latest).hasWithdrawnDependencies ||
                pendingImplementationFix(repo.events(id))?.seq !== fix.seq ||
                current?.cwd !== c.cwd ||
                current.worktreeId !== c.worktreeId ||
                !implementation.attach(c.id, tree)
              )
                throw new InputRefused(conflict);
              const started = data.append(
                id,
                "ai_started",
                {
                  kind: "impl",
                  conversationId: c.id,
                  reason: retryOpening ? "restart" : "start",
                },
                repo.now(),
              );
              return { kind: "issue", issue_id: id, project_id: c.projectId, seq: started.seq };
            }, lease),
          );
        },
        committed: () => {
          if (notice) notices.publish(notice);
        },
      });
    } finally {
      if (!accepted) run.release();
    }
  };

  function queue(
    c: Conversation,
    input: SendInput,
    cancelled: () => boolean,
    queuedIds: readonly string[],
  ) {
    const record = implementationRecord(c);
    if (record?.issue.state === "done")
      return err({
        code: "conflict" as const,
        message: "前の実装が止まってから、もう一度指示を送ってください。",
      });
    return record && awaitsRevision(record)
      ? moveStopped(record, c.id, input, cancelled, queuedIds)
      : ok<PreparedDelivery>({ input });
  }

  return { prepare, queue };
}
