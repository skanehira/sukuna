import { err, ok } from "neverthrow";
import { unavailableRunnerError } from "../../../../shared/ipc";
import {
  designEvents,
  designSubmittedSchema,
  designPrCreatedSchema,
  designPrTargetFromRecordedUrl,
  designApprovalEventSchema,
  designReflectionPlanSchema,
  designConflict,
  designReflecting,
  designNotFound,
  designStale,
  type DesignSubmission,
  type DesignPrTarget,
} from "../../../../shared/api/design";
import { designPrStarted } from "../domain/design-pr-activity";
import type { DesignRecord } from "../../../../shared/design/records";
import type {
  WorktreeActivityLease,
  WorktreeActivityReservation,
} from "../../../../shared/workspace/worktree-activity";
import {
  ProjectRunBlocked,
  type ProjectRunReservation,
} from "../../conversation/domain/conversation-store";
import {
  activeStates,
  conflict,
  type ConversationRuntime,
} from "../../conversation/usecase/runtime";
import {
  designInternal,
  type DesignFlowDependencies,
  type DesignPr,
  type DesignWorktree,
} from "../domain/design-ports";

const prPrompt = (url: string) =>
  `設計書の PR ${url} は承認済みです。CI が通るのを待ち、リポジトリで許された方法で merge してください。設計書の中身は変えないでください。merge できないときは理由を書いて終えてください`;

type Mode = "direct" | "pr" | "none";
class ApprovalExpired extends Error {}

export function createReflectDesign(
  deps: DesignFlowDependencies,
  runtime: ConversationRuntime,
  cleanup: (record: DesignRecord, reflectedHead?: string) => Promise<void>,
) {
  const busy = new Set<string>();
  const jobs = new Set<Promise<void>>();
  const drain = () => Promise.all(jobs);

  function approvable(record: DesignRecord | null, headCommit: string) {
    if (!record) return err(designNotFound);
    if (record.issue.state !== "design_review") return err(designConflict);
    const history = designEvents(record.events);
    if (history.reflecting) return err(designReflecting);
    const submission = designSubmittedSchema.safeParse(history.submission?.payload);
    if (!submission.success || submission.data.headCommit !== headCommit) return err(designStale);
    return ok({ record, submission: submission.data, submissionSeq: history.submission!.seq });
  }

  async function prDestination(record: DesignRecord, tree: DesignWorktree) {
    if (!record.project.usesGithub)
      return err({
        message: "このプロジェクトで PR は作れません。反映のしかたを直接入れる設定にしてください",
      });
    const remote = await deps.git.pushRemote(tree.path);
    if (remote.isErr()) return err(remote.error);
    const target = await deps.gh.target(record.project, remote.value);
    return target.map((prTarget) => ({ prTarget, remote: remote.value }));
  }

  async function approve(id: string, headCommit: string, callerCancelled = () => false) {
    if (callerCancelled()) return err(unavailableRunnerError);
    if (busy.has(id)) return err(designReflecting);
    busy.add(id);
    let scheduled = false;
    let projectRun: ProjectRunReservation | undefined;
    try {
      const permitted = approvable(deps.repo.read(id), headCommit);
      if (permitted.isErr()) return err(permitted.error);
      const { record, submission, submissionSeq } = permitted.value;
      const tree = deps.repo.findTree(id, record.project.id, record.issue.number);
      if (!tree || tree.branch !== submission.branch || record.conversation?.worktreeId !== tree.id)
        return err(designStale);
      projectRun = runtime.store.reserveProjectRun(record.project.id);
      const currentHead = await deps.git.head(record.project.path, `refs/heads/${tree.branch}`);
      if (callerCancelled()) return err(unavailableRunnerError);
      if (currentHead.isErr() || currentHead.value !== headCommit) return err(designStale);
      const changes = await deps.git.hasChanges(
        record.project.path,
        submission.baseCommit,
        headCommit,
      );
      if (callerCancelled()) return err(unavailableRunnerError);
      if (changes.isErr()) return err(designStale);
      const destination =
        changes.value && record.project.designMergeMode === "pr"
          ? await prDestination(record, tree)
          : null;
      if (callerCancelled()) return err(unavailableRunnerError);
      if (destination?.isErr()) return err(designInternal(destination.error.message));
      const prTarget = destination?.isOk() ? destination.value.prTarget : undefined;
      const lease = deps.activity.acquire([tree.id]);
      if (lease.isErr()) return err(lease.error);
      let headGuard: Awaited<ReturnType<typeof deps.git.protectHead>> | undefined;
      let guardReleased: Promise<void> | undefined;
      const accepted = await (async () => {
        try {
          if (callerCancelled()) return err(unavailableRunnerError);
          headGuard = await deps.git.protectHead(record.project.path, tree.branch, headCommit);
          if (callerCancelled()) return err(unavailableRunnerError);
          if (headGuard.isErr()) return err(designStale);
          return deps.transaction((repo) => {
            if (callerCancelled()) return err(unavailableRunnerError);
            if (runtime.closing) return err(designConflict);
            const current = approvable(repo.read(id), headCommit);
            if (current.isErr()) return err(current.error);
            if (current.value.submissionSeq !== submissionSeq) return err(designStale);
            const latest = current.value.record;
            const mode: Mode = changes.value ? latest.project.designMergeMode : "none";
            if (
              mode === "pr" &&
              (!prTarget ||
                !latest.project.usesGithub ||
                prTarget.base !== latest.project.defaultBranch)
            )
              return err(designStale);
            const notice = repo.append(
              latest,
              "design_approved",
              { headCommit, mode, ...(mode === "pr" && prTarget ? { prTarget } : {}) },
              deps.clock.now(),
            );
            if (callerCancelled()) throw new ApprovalExpired();
            return ok({ latest, mode, notice });
          }, lease.value);
        } catch (error) {
          if (error instanceof ApprovalExpired) return err(unavailableRunnerError);
          throw error;
        } finally {
          lease.value.release();
          if (headGuard?.isOk())
            guardReleased = headGuard.value.release().catch((error: unknown) => deps.log(error));
        }
      })();
      if (accepted.isErr()) return err(accepted.error);
      const { latest, mode, notice } = accepted.value;
      void scheduleReflection(latest, tree, submission, mode, projectRun, guardReleased);
      scheduled = true;
      deps.notices.publish(notice);
      return ok({ status: "reflecting" as const });
    } catch (error) {
      if (error instanceof ProjectRunBlocked) return err(conflict(error.message));
      throw error;
    } finally {
      if (!scheduled) {
        try {
          projectRun?.release();
        } finally {
          busy.delete(id);
        }
      }
    }
  }

  function scheduleReflection(
    record: DesignRecord,
    tree: DesignWorktree,
    submission: DesignSubmission,
    mode: Mode,
    projectRun: ProjectRunReservation,
    guardReleased?: Promise<void>,
    recovering = false,
  ) {
    const id = record.issue.id;
    const background = Promise.resolve(guardReleased)
      .then(() => reflectApproved(record, tree, submission, mode, recovering))
      .catch((error: unknown) => {
        deps.log(error);
        try {
          recordFailure(
            record,
            "設計書を反映できませんでした。状態を確認してから、もう一度操作してください",
          );
        } catch (failure) {
          deps.log(failure);
        }
      })
      .finally(() => {
        projectRun.release();
        busy.delete(id);
        jobs.delete(background);
      });
    jobs.add(background);
    return background;
  }

  async function recoverApproval(id: string) {
    if (busy.has(id) || runtime.closing) return;
    const record = deps.repo.read(id);
    if (!record || record.issue.state !== "design_review") return;
    const history = designEvents(record.events);
    const approval = designApprovalEventSchema.safeParse(history.approval?.payload);
    const submission = designSubmittedSchema.safeParse(history.submission?.payload);
    if (!history.reflecting || !approval.success || !submission.success) return;
    const tree = deps.repo.findTree(id, record.project.id, record.issue.number);
    if (
      !tree ||
      tree.branch !== submission.data.branch ||
      record.conversation?.worktreeId !== tree.id
    ) {
      recordFailure(record, "設計の worktree を確認できませんでした");
      return;
    }
    const projectRun = runtime.store.reserveProjectRun(record.project.id);
    busy.add(id);
    if (approval.data.headCommit !== submission.data.headCommit) {
      projectRun.release();
      busy.delete(id);
      recordFailure(record, designStale.message);
      return;
    }
    await scheduleReflection(
      record,
      tree,
      submission.data,
      approval.data.mode,
      projectRun,
      undefined,
      true,
    );
  }

  function recordFailure(
    record: DesignRecord,
    message: string,
    lease?: WorktreeActivityReservation,
  ) {
    const notice = deps.transaction((repo) => {
      const latest = repo.read(record.issue.id);
      return latest?.issue.state === "design_review" && designEvents(latest.events).reflecting
        ? repo.append(latest, "design_reflect_failed", { message }, deps.clock.now())
        : null;
    }, lease);
    if (notice) {
      deps.notices.publish(notice);
      deps.alert(record.issue.id, message);
    }
  }

  function transition(
    record: DesignRecord,
    lease: WorktreeActivityReservation,
    operation:
      | {
          type: "design_reflected";
          payload: { mode: Mode; commit: string | null; prUrl: string | null };
          reconciledPr?: boolean;
        }
      | { type: "design_pr_created"; payload: { prUrl: string } }
      | { type: "design_pr_not_merged"; detail: string },
  ) {
    const notice = deps.transaction((repo) => {
      const latest = repo.read(record.issue.id);
      if (!latest) return null;
      const now = deps.clock.now();
      const detail = operation.type === "design_pr_not_merged" ? operation.detail : undefined;
      if (!repo.move(latest, operation.type, now, detail)) return null;
      if (
        operation.type === "design_pr_created" ||
        (operation.type === "design_reflected" && operation.reconciledPr)
      ) {
        const conversationSeq = latest.conversation
          ? runtime.store.get(latest.conversation.id)?.lastSeq
          : undefined;
        const created = repo.append(
          latest,
          "design_pr_created",
          { prUrl: operation.payload.prUrl, conversationSeq },
          now,
        );
        if (operation.type === "design_pr_created") return created;
      }
      if (operation.type !== "design_pr_not_merged")
        return repo.append(latest, operation.type, operation.payload, now);
      const saved = repo.read(record.issue.id)!;
      return {
        kind: "issue" as const,
        issue_id: saved.issue.id,
        project_id: saved.project.id,
        seq: saved.events.at(-1)!.seq,
      };
    }, lease);
    if (notice) deps.notices.publish(notice);
    return Boolean(notice);
  }

  async function reflectApproved(
    record: DesignRecord,
    tree: DesignWorktree,
    submission: DesignSubmission,
    mode: Mode,
    recovering: boolean,
  ) {
    const conversationId = record.conversation!.id;
    const release = await runtime.release(conversationId);
    if (release.isErr()) return recordFailure(record, release.error.message);
    const lease = deps.activity.acquire([tree.id]);
    if (lease.isErr()) return recordFailure(record, lease.error.message);
    try {
      const latest = deps.repo.read(record.issue.id);
      if (latest?.issue.state !== "design_review" || !designEvents(latest.events).reflecting)
        return;
      return await reflect(latest, tree, submission, mode, lease.value, recovering);
    } finally {
      lease.value.release();
    }
  }

  async function reflect(
    record: DesignRecord,
    tree: DesignWorktree,
    submission: DesignSubmission,
    mode: Mode,
    lease: WorktreeActivityLease,
    recovering: boolean,
  ) {
    const history = designEvents(record.events);
    const approval = designApprovalEventSchema.safeParse(history.approval?.payload);
    if (
      !approval.success ||
      approval.data.headCommit !== submission.headCommit ||
      approval.data.mode !== mode
    )
      return recordFailure(record, designStale.message, lease);
    if (mode === "pr") {
      const target = approval.data.prTarget;
      if (!target)
        return recordFailure(
          record,
          "承認時の PR の作成先を確認できませんでした。origin と既定ブランチを確認して、同じ版をもう一度承認してください",
          lease,
        );
      const previous = record.events.findLast(
        (event) => event.type === "design_approved" && event.seq < history.approval!.seq,
      );
      const previousApproval = designApprovalEventSchema.safeParse(previous?.payload);
      const retrying =
        previousApproval.success &&
        previousApproval.data.mode === "pr" &&
        previousApproval.data.headCommit === submission.headCommit;
      return reflectPr(record, tree, submission, lease, target, recovering || retrying);
    }
    let commit: string | null = null;
    if (mode === "direct") {
      const plan = designReflectionPlanSchema.safeParse(history.plan?.payload);
      const reflected = await deps.git.reflect(record.project, tree, submission, {
        plan: plan.success ? plan.data : undefined,
        savePlan: (planned) =>
          deps.transaction((repo) => {
            const latest = repo.read(record.issue.id);
            if (
              !latest ||
              latest.issue.state !== "design_review" ||
              designEvents(latest.events).approval?.seq !== history.approval?.seq
            )
              return false;
            repo.append(latest, "design_reflection_prepared", planned, deps.clock.now());
            return true;
          }, lease),
      });
      if (reflected.isErr()) return recordFailure(record, reflected.error.message, lease);
      commit = reflected.value;
    } else {
      const latest = await deps.git.head(record.project.path, `refs/heads/${tree.branch}`);
      if (latest.isErr() || latest.value !== submission.headCommit)
        return recordFailure(record, designStale.message, lease);
    }
    if (
      !transition(record, lease, {
        type: "design_reflected",
        payload: { mode, commit, prUrl: null },
      })
    )
      return recordFailure(
        record,
        "設計の反映結果を記録できませんでした。issue を読み直してください",
        lease,
      );
    lease.release();
    await cleanup(record, mode === "direct" ? submission.headCommit : undefined);
  }

  async function reflectPr(
    record: DesignRecord,
    tree: DesignWorktree,
    submission: DesignSubmission,
    lease: WorktreeActivityLease,
    target: DesignPrTarget,
    checkExisting: boolean,
  ) {
    const { project, issue } = record;
    const { headCommit } = submission;
    const failure = (message: string) => recordFailure(record, message, lease);
    const changed =
      "承認した設計の PR の作成先が変わりました。origin と既定ブランチを確認してから、もう一度承認してください";
    let pr: DesignPr | null = null;
    if (checkExisting) {
      const existing = await deps.gh.find(project, target, tree.branch, headCommit);
      if (existing.isErr()) return failure(existing.error.message);
      pr = existing.value;
      if (pr?.state === "MERGED") {
        const verified = await deps.gh.verify(project, target, pr.url, tree.branch, headCommit);
        if (verified.isErr()) return failure(verified.error.message);
        if (verified.value.state !== "MERGED")
          return failure("設計書の PR の merge コミットを確認できませんでした");
        pr = verified.value;
      }
    }

    if (!pr) {
      const destination = await prDestination(record, tree);
      if (destination.isErr()) return failure(destination.error.message);
      const { prTarget, remote } = destination.value;
      const latest = deps.repo.read(issue.id);
      if (
        prTarget.repository.toLowerCase() !== target.repository.toLowerCase() ||
        prTarget.base !== target.base ||
        latest?.project.defaultBranch !== target.base ||
        !latest.project.usesGithub
      )
        return failure(changed);
      const pushed = await deps.git.pushBranch(tree, headCommit, remote);
      if (pushed.isErr())
        return failure(
          `設計のブランチを push できませんでした: ${pushed.error.message}。状態を確認してから、もう一度承認してください`,
        );
      const created = await deps.gh.create(
        project,
        target,
        tree.branch,
        `設計: #${issue.number} ${issue.title}`,
        [
          "## 修正方針",
          "",
          submission.policy,
          "",
          "## AI が確かめたい点",
          "",
          ...(submission.checks.length
            ? submission.checks.map((check) => `- ${check}`)
            : ["ありません"]),
        ].join("\n"),
      );
      if (created.isErr()) return failure(created.error.message);
      const verified = await deps.gh.verify(
        project,
        target,
        created.value,
        tree.branch,
        headCommit,
      );
      if (verified.isErr()) return failure(verified.error.message);
      pr = verified.value;
    }

    if (pr.state === "CLOSED") return failure("作成した設計書の PR は閉じています");
    if (pr.state === "MERGED") {
      if (!pr.mergeCommit) return failure("設計書の PR の merge コミットを確認できませんでした");
      if (
        !transition(record, lease, {
          type: "design_reflected",
          payload: { mode: "pr", commit: pr.mergeCommit, prUrl: pr.url },
          reconciledPr: true,
        })
      )
        return failure("設計の反映結果を記録できませんでした。issue を読み直してください");
      lease.release();
      await cleanup(record);
      return;
    }
    if (!transition(record, lease, { type: "design_pr_created", payload: { prUrl: pr.url } }))
      return failure(
        "設計書の PR は作成されましたが、反映の状態を記録できませんでした。issue を読み直してください",
      );
    lease.release();
    await sendPrInstruction(issue.id, pr.url);
  }

  function allowsPr(record: DesignRecord) {
    return (
      deps.allowPrInstruction?.(record.project.id) ??
      (!record.project.flowPaused && record.project.autoStages.includes("design"))
    );
  }

  async function sendPrInstruction(id: string, url: string) {
    const initial = deps.repo.read(id);
    const conversationId = initial?.conversation?.id;
    if (!conversationId) return err(designNotFound);
    return runtime.serial(conversationId, async () => {
      const latest = deps.repo.read(id);
      const conversation = runtime.store.get(conversationId);
      if (!latest || !conversation || conversation.closedAt !== null || runtime.closing)
        return err(designConflict);
      if (!allowsPr(latest)) return ok(undefined);
      const pending = designEvents(latest.events);
      const activePr = designPrCreatedSchema.safeParse(pending.pr?.payload);
      if (latest.issue.state !== "design" || !activePr.success || activePr.data.prUrl !== url)
        return err(designConflict);
      const mark = pending.pr!;
      const eligible = () => {
        const record = deps.repo.read(id);
        const latestPr = record && designEvents(record.events).pr;
        return (
          record?.issue.state === "design" &&
          latestPr?.seq === mark.seq &&
          allowsPr(record) &&
          !runtime.store
            .list()
            .some(
              (c) =>
                c.issueId === id &&
                c.kind !== "chat" &&
                c.kind !== "thread" &&
                activeStates.includes(c.runState),
            ) &&
          !designPrStarted(mark, record.events, runtime.store.events(conversationId))
        );
      };
      if (!eligible()) return ok(undefined);
      let notice: ReturnType<typeof deps.repo.append> | undefined;
      const result = await runtime.deliver(
        conversationId,
        { text: prPrompt(url), images: [], origin: "flow" },
        {
          events: [],
          check: () => (eligible() ? null : designConflict),
          before: () => {
            const recorded = deps.repo.read(id)!;
            notice = deps.repo.append(
              recorded,
              "ai_started",
              {
                kind: "design",
                reason: "design_pr_merge",
                conversationId,
              },
              deps.clock.now(),
            );
          },
        },
        { includeQueued: false },
      );
      if (result.isErr()) {
        if (!eligible()) return ok(undefined);
        deps.alert(id, result.error.message);
        return err(result.error);
      }
      if (notice) deps.notices.publish(notice);
      return ok(undefined);
    });
  }

  async function completePr(id: string, lastAssistantText: string) {
    if (busy.has(id)) return err(designReflecting);
    const record = deps.repo.read(id);
    if (!record) return err(designNotFound);
    const history = designEvents(record.events);
    const pr = designPrCreatedSchema.safeParse(history.pr?.payload);
    const approval = designApprovalEventSchema.safeParse(history.approval?.payload);
    if (
      record.issue.state !== "design" ||
      !approval.success ||
      approval.data.mode !== "pr" ||
      !pr.success
    )
      return err(designConflict);
    const tree = deps.repo.findTree(id, record.project.id, record.issue.number);
    if (!tree) return err(designConflict);
    const lease = deps.activity.acquire([tree.id]);
    if (lease.isErr()) return err(lease.error);
    busy.add(id);
    try {
      const target =
        approval.data.prTarget ??
        designPrTargetFromRecordedUrl(pr.data.prUrl, record.project.defaultBranch);
      if (!target)
        return err(designInternal("記録した設計書の PR のリポジトリを確認できませんでした"));
      const remote = await deps.gh.verify(
        record.project,
        target,
        pr.data.prUrl,
        tree.branch,
        approval.data.headCommit,
      );
      if (remote.isErr()) return err(designInternal(remote.error.message));
      if (remote.value.state === "MERGED" && remote.value.mergeCommit === null)
        return err(designInternal("設計書の PR の merge コミットを確認できませんでした"));
      if (remote.value.state !== "MERGED") {
        const detail =
          lastAssistantText.split(/\r?\n/, 1)[0]?.trim() || "設計書の PR は merge されていません";
        return transition(record, lease.value, { type: "design_pr_not_merged", detail })
          ? ok(undefined)
          : err(designConflict);
      }
      if (
        !transition(record, lease.value, {
          type: "design_reflected",
          payload: { mode: "pr", commit: remote.value.mergeCommit, prUrl: pr.data.prUrl },
        })
      )
        return err(designConflict);
      lease.value.release();
      await cleanup(record);
      return ok(undefined);
    } finally {
      busy.delete(id);
      lease.value.release();
    }
  }

  return {
    approve,
    completePr,
    sendPrInstruction,
    recoverApproval,
    reflecting: (id: string) => busy.has(id),
    drain,
  };
}
