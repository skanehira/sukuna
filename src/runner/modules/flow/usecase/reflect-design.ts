import { err, ok } from "neverthrow";
import { unavailableRunnerError } from "../../../../shared/ipc";
import {
  designEvents,
  designSubmittedSchema,
  designPrCreatedSchema,
  designApprovalEventSchema,
  designConflict,
  designReflecting,
  designNotFound,
  designStale,
  type DesignSubmission,
} from "../../../../shared/api/design";
import type { DesignRecord } from "../../../../shared/design/records";
import type {
  WorktreeActivityLease,
  WorktreeActivityReservation,
} from "../../../../shared/workspace/worktree-activity";
import { activeStates, type ConversationRuntime } from "../../conversation/usecase/runtime";
import {
  designInternal,
  type DesignFlowDependencies,
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

  async function approve(id: string, headCommit: string, callerCancelled = () => false) {
    if (callerCancelled()) return err(unavailableRunnerError);
    if (busy.has(id)) return err(designReflecting);
    busy.add(id);
    let scheduled = false;
    try {
      const permitted = approvable(deps.repo.read(id), headCommit);
      if (permitted.isErr()) return err(permitted.error);
      const { record, submission, submissionSeq } = permitted.value;
      const tree = deps.repo.findTree(id, record.project.id, record.issue.number);
      if (!tree || tree.branch !== submission.branch || record.conversation?.worktreeId !== tree.id)
        return err(designStale);
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
            const notice = repo.append(
              latest,
              "design_approved",
              { headCommit, mode },
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
      deps.notices.publish(notice);
      scheduled = true;
      const background = Promise.resolve()
        .then(() => guardReleased)
        .then(() => reflectApproved(latest, tree, submission, mode))
        .catch((error: unknown) => {
          deps.log(error);
          try {
            recordFailure(
              latest,
              "設計書を反映できませんでした。状態を確認してから、もう一度操作してください",
            );
          } catch (failure) {
            deps.log(failure);
          }
        })
        .finally(() => {
          busy.delete(id);
          jobs.delete(background);
        });
      jobs.add(background);
      return ok({ status: "reflecting" as const });
    } finally {
      if (!scheduled) busy.delete(id);
    }
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
      return await reflect(latest, tree, submission, mode, lease.value);
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
  ) {
    if (mode === "pr") {
      if (!record.project.usesGithub)
        return recordFailure(
          record,
          "このプロジェクトで PR は作れません。反映のしかたを直接入れる設定にしてください",
          lease,
        );
      const pushed = await deps.git.pushBranch(tree, submission.headCommit);
      if (pushed.isErr())
        return recordFailure(
          record,
          `設計のブランチを push できませんでした: ${pushed.error.message}。状態を確認してから、もう一度承認してください`,
          lease,
        );
      const pr = await deps.gh.create(
        record.project,
        tree.branch,
        `設計: #${record.issue.number} ${record.issue.title}`,
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
      if (pr.isErr()) return recordFailure(record, pr.error.message, lease);
      if (!transition(record, lease, { type: "design_pr_created", payload: { prUrl: pr.value } }))
        return recordFailure(
          record,
          "設計書の PR は作成されましたが、反映の状態を記録できませんでした。issue を読み直してください",
          lease,
        );
      lease.release();
      await sendPrInstruction(record.issue.id, pr.value);
      return;
    }
    let commit: string | null = null;
    if (mode === "direct") {
      const reflected = await deps.git.reflect(record.project, tree, submission);
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

  async function sendPrInstruction(id: string, url: string) {
    const initial = deps.repo.read(id);
    const conversationId = initial?.conversation?.id;
    if (!conversationId) return err(designNotFound);
    return runtime.serial(conversationId, async () => {
      const latest = deps.repo.read(id);
      const conversation = runtime.store.get(conversationId);
      if (!latest || !conversation || conversation.closedAt !== null || runtime.closing)
        return err(designConflict);
      if (latest.project.flowPaused || !latest.project.autoStages.includes("design"))
        return ok(undefined);
      const pending = designEvents(latest.events);
      const activePr = designPrCreatedSchema.safeParse(pending.pr?.payload);
      if (latest.issue.state !== "design" || !activePr.success || activePr.data.prUrl !== url)
        return err(designConflict);
      if (latest.events.some((event) => event.type === "ai_started" && event.seq > pending.pr!.seq))
        return ok(undefined);
      let notice: ReturnType<typeof deps.repo.append> | undefined;
      const result = await runtime.deliver(
        conversationId,
        { text: prPrompt(url), images: [], origin: "flow" },
        {
          events: [],
          before: () => {
            const recorded = deps.repo.read(id);
            const updated = recorded && designEvents(recorded.events);
            if (recorded?.issue.state !== "design" || updated?.pr?.seq !== pending.pr?.seq)
              throw new Error("設計の PR の状態が変わりました");
            if (recorded.project.flowPaused || !recorded.project.autoStages.includes("design"))
              throw new Error("設計の自動処理は一時停止中です");
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
        { includeQueued: false, interrupt: activeStates.includes(conversation.runState) },
      );
      if (result.isErr()) {
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
      const remote = await deps.gh.view(record.project, pr.data.prUrl);
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
    reflecting: (id: string) => busy.has(id),
    drain,
  };
}
