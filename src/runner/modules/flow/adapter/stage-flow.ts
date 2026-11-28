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
import { implementationOrigin } from "../domain/impl-history";
import { hasFlowHistory } from "../domain/evaluate";
import type { IssueNoticePort } from "../domain/ports";
import type { createDesignFlow } from "./design-dependencies";
import { createIssueUnitOfWork } from "./issue-repository";
import type { StageRepository } from "../domain/stage-ports";
import { createImplementationFlow } from "./impl-flow";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import type { ImplementationTerminalCleanup } from "../domain/impl-ports";
import type { GitRunner } from "../../workspace/adapter/git-cli";

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
  gh: GhRunner,
  terminals: ImplementationTerminalCleanup,
  git?: GitRunner,
) {
  const move = createMoveState({
    unitOfWork: createIssueUnitOfWork(database),
    notices,
    clock: repo,
  });
  const deferredParents = new Map<string, () => void>();
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
  const implementation = createImplementationFlow(
    database,
    repo,
    runtime,
    notices,
    allows,
    gh,
    git,
    logFailure,
    terminals,
    schedule,
  );
  const evaluate = createEvaluateProject({
    repo,
    runtime,
    design,
    notices,
    allows,
    move,
    implementation,
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
          const { selected, retry } = implementation.claim(
            projectId,
            implementation.checkParentsWithin,
          );
          deferredParents.get(projectId)?.();
          deferredParents.delete(projectId);
          if (retry) {
            deferredParents.set(
              projectId,
              runtime.options.clock.setTimeout(() => {
                deferredParents.delete(projectId);
                schedule(projectId);
              }, 250),
            );
          }
          const order = new Set([...selected, ...repo.issues(projectId).map(({ id }) => id)]);
          for (const id of order) {
            if (closing) return;
            await evaluate(id).catch((error: unknown) => logFailure(error, id));
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
    if (owner === c.kind) {
      if (
        c.kind === "impl" &&
        c.worktreeId &&
        implementationOrigin(record.events) &&
        !implementation.activeTree(c.projectId, c.id)
      )
        return err({
          code: "conflict" as const,
          message: "記録した実装の worktree が変わりました。",
        });
      return ok(undefined);
    }
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
    createStageWorktreeRetry(repo, runtime, design, notices, implementation),
  );
  const unsubscribe = runtime.subscribe((signal) =>
    onConversationSignal(runtime, repo, notices, schedule, signal),
  );
  return {
    schedule,
    recoverBeforeConversations: implementation.recoverBeforeConversations,
    notify(this: void, input: { project_id?: string; issue_id?: string }) {
      if (input.issue_id !== undefined) {
        const issue = repo.data.get(input.issue_id);
        if (issue) {
          implementation.noteExternalMerge(issue.id);
          schedule(issue.projectId);
        }
      } else if (input.project_id !== undefined) schedule(input.project_id);
      else for (const project of repo.projects()) schedule(project.id);
    },
    reports: createStageReports(repo, notices, design, implementation.reports),
    async finishWithdrawal(id: string) {
      const record = repo.read(id);
      if (record?.issue.state === "withdrawn") await implementation.cleanup(record);
    },
    recover: () => {
      recovery = recoverAfterRestart(
        repo,
        runtime,
        design,
        move,
        schedule,
        logFailure,
        implementation,
      ).catch(logFailure);
    },
    stop: async () => {
      closing = true;
      for (const cancel of deferredParents.values()) cancel();
      deferredParents.clear();
      unsubscribe();
      await Promise.all([recovery, ...[...projects.values()].map(({ job }) => job)]);
    },
  };
}
