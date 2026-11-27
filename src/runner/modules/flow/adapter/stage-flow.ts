import { err, ok } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import type { Logger } from "../../../../shared/log";
import type { Conversation } from "../../conversation/domain/conversation-store";
import { activeStates, type ConversationRuntime } from "../../conversation/usecase/runtime";
import { createEvaluateProject } from "../usecase/evaluate-project";
import { createFlowGate } from "../usecase/flow-gate";
import { createMoveState } from "../usecase/move-state";
import { onConversationSignal } from "../usecase/on-conversation-signal";
import { createStageReports } from "../usecase/on-report";
import { recoverAfterRestart } from "../usecase/recover-after-restart";
import { createStageWorktreeRetry } from "../usecase/retry-stage-worktree";
import { hasFlowHistory } from "../domain/evaluate";
import type { IssueNoticePort } from "../domain/ports";
import type { createDesignFlow } from "./design-dependencies";
import { createIssueUnitOfWork } from "./issue-repository";
import type { StageRepository } from "../domain/stage-ports";
import { unavailableIssueReports } from "../../issue/adapter/app-tools";

const stages = { triage: "精査", design: "設計", impl: "実装" };
const stateNames = {
  draft: "下書き",
  triage: "精査待ち",
  design: "設計待ち",
  design_review: "設計レビュー",
  ready: "実装待ち",
  implementing: "実装中",
  done: "完了",
  stopped: "停止中",
  withdrawn: "取り下げ",
} as const;

export function createStageFlow(
  database: OpenedDatabase,
  repo: StageRepository,
  runtime: ConversationRuntime,
  design: ReturnType<typeof createDesignFlow>,
  allows: ReturnType<typeof createFlowGate>,
  notices: IssueNoticePort,
  log: Logger,
) {
  const move = createMoveState({
    unitOfWork: createIssueUnitOfWork(database),
    notices,
    clock: repo,
  });
  const evaluate = createEvaluateProject({ repo, runtime, design, notices, allows, move });
  const projects = new Map<string, { pending: boolean; job: Promise<void> }>();
  let closing = false;
  let recovery: Promise<void> | undefined;
  const logFailure = (error: unknown, id?: string) =>
    log({
      level: "error",
      component: "runner.flow",
      message: "issue の自動処理に失敗しました。",
      ...(id ? { issue_id: id } : {}),
      error,
    });
  function schedule(projectId: string) {
    if (closing) return;
    const current = projects.get(projectId);
    if (current) {
      current.pending = true;
      return;
    }
    const entry = { pending: true, job: Promise.resolve() };
    entry.job = Promise.resolve()
      .then(async () => {
        while (!closing && entry.pending) {
          entry.pending = false;
          for (const issue of repo.issues(projectId)) {
            if (closing) return;
            await evaluate(issue.id).catch((error: unknown) => logFailure(error, issue.id));
          }
        }
      })
      .catch((error: unknown) => logFailure(error))
      .finally(() => {
        projects.delete(projectId);
        if (entry.pending) schedule(projectId);
      });
    projects.set(projectId, entry);
  }

  function guard(c: Conversation) {
    if (!c.issueId || c.kind === "chat" || c.kind === "thread") return ok(undefined);
    const record = repo.read(c.issueId);
    if (!record || !hasFlowHistory(record.events)) return ok(undefined);
    const { issue, context } = record;
    const state = issue.state === "stopped" ? context.stoppedFrom : issue.state;
    const owner =
      state === "triage"
        ? "triage"
        : state === "design" || state === "design_review"
          ? "design"
          : state === "ready" || state === "implementing" || state === "done"
            ? "impl"
            : null;
    if (owner === c.kind) return ok(undefined);
    const hasOwner =
      owner &&
      runtime.store
        .list()
        .some((item) => item.issueId === issue.id && item.kind === owner && item.closedAt === null);
    const message =
      owner && hasOwner
        ? `この issue はいま ${stages[owner]} の会話で進んでいます`
        : `この issue はいま ${stateNames[issue.state]} なので、この会話には送れません`;
    return err({ code: "conflict" as const, message });
  }
  runtime.runOptions.registerDeliveryGuard(guard);
  runtime.runOptions.registerStartGuard((conversation, checkOwner) => {
    if (checkOwner) {
      const owner = guard(conversation);
      if (owner.isErr()) return owner.error;
    }
    if (!conversation.issueId || conversation.kind === "chat" || conversation.kind === "thread")
      return null;
    const otherActive = runtime.store
      .list()
      .some(
        (other) =>
          other.id !== conversation.id &&
          other.issueId === conversation.issueId &&
          other.kind !== "chat" &&
          other.kind !== "thread" &&
          activeStates.includes(other.runState),
      );
    return otherActive
      ? { code: "conflict", message: "この issue の別の段階で AI が動いています。" }
      : null;
  });
  runtime.runOptions.registerDeliveryPreparer(
    createStageWorktreeRetry(repo, runtime, design, notices),
  );
  const unsubscribe = runtime.subscribe((signal) =>
    onConversationSignal(runtime, repo, notices, schedule, signal),
  );
  return {
    schedule,
    notify(this: void, input: { project_id?: string; issue_id?: string }) {
      if (input.issue_id !== undefined) {
        const issue = repo.data.get(input.issue_id);
        if (issue) schedule(issue.projectId);
      } else if (input.project_id !== undefined) schedule(input.project_id);
      else for (const project of repo.projects()) schedule(project.id);
    },
    reports: createStageReports(repo, notices, design, unavailableIssueReports),
    recover: () => {
      recovery = recoverAfterRestart(repo, runtime, design, move, schedule, logFailure).catch(
        logFailure,
      );
    },
    stop: async () => {
      closing = true;
      unsubscribe();
      await Promise.all([recovery, ...[...projects.values()].map(({ job }) => job)]);
    },
  };
}
