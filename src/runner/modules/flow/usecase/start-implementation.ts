import type { IssueDataRepository } from "../../../../shared/issue/ports";
import { basename, dirname, join } from "node:path";
import { monotonicFactory, decodeTime } from "ulid";
import { err, ok, type Result } from "neverthrow";
import { unavailableRunnerError } from "../../../../shared/ipc";
import {
  issueHistoryPoint,
  implementationOrigin,
  implementationState,
  pendingImplementationFix,
} from "../domain/impl-history";
import {
  InputRefused,
  activeStates,
  type ConversationRuntime,
} from "../../conversation/usecase/runtime";
import type { Conversation } from "../../conversation/domain/conversation-store";
import type { IssueNoticePort, IssueRepositoryPort } from "../domain/ports";
import type { StageRepository, StageSnapshot } from "../domain/stage-ports";
import type {
  ImplementationGit,
  ImplementationGithub,
  ImplementationTree,
  ImplementationTrees,
} from "../domain/impl-ports";
import { implementationInstruction } from "../domain/impl-instructions";
import { implementationQueue, type ImplementationCandidate } from "../domain/impl-queue";
import { implementationWorktreeName, reusableImplementationTree } from "../domain/impl-worktree";
import { restartInstruction } from "../domain/instructions";
import { firstLine } from "./on-report";
import { moveStateWithin } from "./move-state";
import type { createFlowGate } from "./flow-gate";

type WorkspaceError = {
  code: "conflict" | "worktree_failed" | "runner_unavailable";
  message: string;
};

const conflicted = { code: "conflict" as const, message: "実装の作業条件が変わりました。" };
const projectPath = ".claude/worktrees";

export function createImplementationStart(deps: {
  repo: StageRepository;
  runtime: ConversationRuntime;
  git: ImplementationGit;
  gh: ImplementationGithub;
  trees: ImplementationTrees;
  notices: IssueNoticePort;
  allows: ReturnType<typeof createFlowGate>;
}) {
  const { repo, runtime, git, gh, trees, notices, allows } = deps;
  const id = monotonicFactory();
  const preparing = new Set<string>();

  function stageConversations(issueId: string) {
    return runtime.store
      .list()
      .filter((c) => c.issueId === issueId && ["triage", "design", "impl"].includes(c.kind));
  }

  async function repository(project: { path: string; usesGithub: boolean }) {
    if (!project.usesGithub) return ok(null);
    const origin = await git.origin(project.path);
    if (origin.isErr()) return err(origin.error);
    return gh
      .target(project.path, origin.value)
      .then((result) =>
        result.mapErr((error) => ({ code: "internal" as const, message: error.message })),
      );
  }

  async function prepare(
    issueId: string,
    conversationId: string,
    cancelled = () => false,
  ): Promise<Result<ImplementationTree, WorkspaceError>> {
    if (preparing.has(issueId)) return err(conflicted);
    preparing.add(issueId);
    try {
      return await createOrReuse(issueId, conversationId, cancelled);
    } finally {
      preparing.delete(issueId);
    }
  }

  async function createOrReuse(
    issueId: string,
    conversationId: string,
    cancelled: () => boolean,
  ): Promise<Result<ImplementationTree, WorkspaceError>> {
    const record = repo.read(issueId);
    if (cancelled() || runtime.closing) return err(unavailableRunnerError);
    if (!record || record.project.removedAt !== null || !implementationState(record))
      return err(conflicted);
    const { project, issue, events } = record;
    const current = () => {
      const now = repo.read(issueId);
      const c = runtime.store.get(conversationId);
      return (
        now?.project.removedAt === null &&
        now.issue.state === record.issue.state &&
        issueHistoryPoint(now.events) === issueHistoryPoint(events) &&
        c?.issueId === issueId &&
        c.kind === "impl" &&
        c.closedAt === null
      );
    };
    const failed = (
      detail: string,
      reservation?: Parameters<StageRepository["transaction"]>[1],
    ) => {
      if (cancelled() || runtime.closing) return err(unavailableRunnerError);
      if (!current()) return err(conflicted);
      const message = `worktree を作れませんでした: ${firstLine(detail)}`;
      let notice: Parameters<IssueNoticePort["publish"]>[0] | undefined;
      try {
        runtime.record(
          conversationId,
          [{ type: "stopped", payload: { reason: "error", detail: message } }],
          () => {
            const result = repo.transaction(
              (flow) =>
                moveStateWithin(
                  flow,
                  { issueId, trigger: "worktree_failed", detail: message },
                  repo.now(),
                ),
              reservation,
            );
            if (result.kind !== "moved") throw new InputRefused(conflicted);
            notice = result.notice;
          },
          current,
          () => {
            if (cancelled() || runtime.closing) throw new InputRefused(unavailableRunnerError);
          },
        );
      } catch (error) {
        if (error instanceof InputRefused)
          return err(
            error.refusal.code === "runner_unavailable" ? unavailableRunnerError : conflicted,
          );
        throw error;
      }
      if (notice) notices.publish(notice);
      return err({ code: "worktree_failed" as const, message });
    };

    const root = join(await git.canonical(project.path), projectPath);
    if (
      (await git.canonical(root)) !== root ||
      (await git.canonical(dirname(root))) !== dirname(root)
    )
      return failed("プロジェクトの worktree 用フォルダを確認できませんでした");
    const listed = await git.list(project.path);
    if (listed.isErr()) return failed(listed.error.message);
    const since = events.findLast((event) =>
      ["implementation_done", "reopened_for_fix"].includes(event.type),
    );
    const treesForIssue = trees.list(project.id).filter((tree) => tree.issueId === issueId);
    const reusable = reusableImplementationTree(
      treesForIssue.map((tree) => ({ ...tree, createdAt: decodeTime(tree.id) })),
      since?.createdAt ?? -1,
    );
    if (reusable) {
      if (dirname(reusable.path) !== root) return failed("記録した worktree の場所が変わりました");
      const lease = trees.activity.acquire([reusable.id]);
      if (lease.isErr()) return err(conflicted);
      try {
        const entry = listed.value.find((worktree) => worktree.path === reusable.path);
        const present = await git.exists(reusable.path);
        if (present.isErr()) return failed(present.error.message, lease.value);
        if (entry || present.value) {
          if (
            entry?.branch !== reusable.branch ||
            !present.value ||
            !git.owns(reusable.path, reusable.identity) ||
            reusable.cleanupPath !== null
          )
            return failed("記録した worktree が変わりました", lease.value);
          if (!reusable.identity)
            return failed("作成した worktree の記録がありません", lease.value);
          const copied = await git.include(project.path, reusable.path, reusable.identity);
          if (copied.isErr()) return failed(copied.error.message, lease.value);
          return cancelled() || runtime.closing ? err(unavailableRunnerError) : ok(reusable);
        }
        if (cancelled() || runtime.closing) return err(unavailableRunnerError);
        if (!current()) return err(conflicted);
        trees.abandon(reusable.id, repo.now());
      } finally {
        lease.value.release();
      }
    }
    const excluded = await git.exclude(project.path);
    if (excluded.isErr()) return failed(excluded.error.message);
    const fetched = project.usesGithub && (await git.fetch(project.path, project.defaultBranch));
    const ref =
      fetched && fetched.isOk()
        ? `refs/remotes/origin/${project.defaultBranch}`
        : `refs/heads/${project.defaultBranch}`;
    const names = [
      ...listed.value.map((row) => basename(row.path)),
      ...trees.list(project.id).map((row) => basename(row.path)),
    ];
    const branches: string[] = [];
    for (;;) {
      const { name, branch } = implementationWorktreeName(issue.number, names, branches);
      const hasBranch = await git.branchExists(project.path, branch);
      if (hasBranch.isErr()) return failed(hasBranch.error.message);
      if (hasBranch.value) {
        branches.push(branch);
        continue;
      }
      const path = join(root, name);
      const present = await git.exists(path);
      if (present.isErr()) return failed(present.error.message);
      if (present.value) return failed(`作業場所が既にあります: ${path}`);
      if (cancelled() || runtime.closing) return err(unavailableRunnerError);
      if (!current()) return err(conflicted);
      const treeId = id(repo.now() + (since?.createdAt === repo.now() ? 1 : 0));
      const lease = trees.activity.acquire([treeId]);
      if (lease.isErr()) return err(conflicted);
      try {
        const tree = repo.transaction(() => {
          if (!current() || trees.list(project.id).some((row) => row.path === path)) return;
          return trees.reserve({ id: treeId, projectId: project.id, issueId, path, branch });
        }, lease.value);
        if (!tree) return err(conflicted);
        if (cancelled() || runtime.closing) return err(unavailableRunnerError);
        const added = await git.createOwned(project.path, path, branch, ref);
        if (added.isErr()) {
          const available = await git.exists(path);
          if (available.isOk() && !available.value) trees.abandon(tree.id, repo.now());
          return failed(added.error.message, lease.value);
        }
        trees.bindIdentity(tree.id, added.value);
        const copied = await git.include(project.path, path, added.value);
        if (copied.isErr()) return failed(copied.error.message, lease.value);
        return ok({ ...tree, identity: added.value });
      } finally {
        lease.value.release();
      }
    }
  }

  function activeTree(projectId: string, conversationId: string) {
    const c = runtime.store.get(conversationId);
    if (!c?.worktreeId || c.projectId !== projectId || c.kind !== "impl" || c.closedAt !== null)
      return;
    const tree = trees.list(projectId).find(({ id }) => id === c.worktreeId);
    if (tree?.issueId === c.issueId && tree?.path === c.cwd && git.owns(tree.path, tree.identity))
      return tree;
  }

  function attach(conversationId: string, tree: ImplementationTree) {
    return git.owns(tree.path, tree.identity) && trees.attach(conversationId, tree);
  }

  async function instruction(issueId: string, tree: ImplementationTree) {
    const record = repo.read(issueId);
    if (!record) return "";
    const target = await repository(record.project);
    return implementationInstruction(
      record.issue,
      record.project,
      tree,
      target.isOk() ? target.value : null,
    );
  }

  async function deliver(
    c: Conversation,
    issueId: string,
    text: string,
    reason: "start" | "restart" | "resume_dependency" | "nudge",
    revision: number | undefined,
    tree?: ImplementationTree,
  ) {
    await runtime.serial(c.id, async () => {
      const check = () => {
        const record = repo.read(issueId);
        const ownership = tree ?? activeTree(c.projectId, c.id);
        return !record ||
          !ownership ||
          !git.owns(ownership.path, ownership.identity) ||
          record.issue.state !== "implementing" ||
          record.project.removedAt !== null ||
          !allows(c.projectId, "impl") ||
          record.context.hasWithdrawnDependencies ||
          record.events.at(-1)?.seq !== revision ||
          runtime.store.get(c.id)?.lastSeq !== c.lastSeq ||
          stageConversations(issueId).some((row) => activeStates.includes(row.runState))
          ? conflicted
          : null;
      };
      if (runtime.closing || check()) return ok(undefined);
      let notice: Parameters<IssueNoticePort["publish"]>[0] | undefined;
      const result = await runtime.deliver(
        c.id,
        { text, origin: "flow", images: [] },
        {
          events: [],
          workspace: tree,
          check,
          before() {
            if (tree && !attach(c.id, tree)) throw new InputRefused(conflicted);
            const event = repo.append(
              issueId,
              reason === "nudge" ? "report_nudged" : "ai_started",
              reason === "nudge"
                ? { conversationId: c.id }
                : { kind: "impl", conversationId: c.id, reason },
            );
            notice = { kind: "issue", issue_id: issueId, project_id: c.projectId, seq: event.seq };
          },
        },
        { includeQueued: false },
      );
      if (notice && result.isOk()) notices.publish(notice);
      return result;
    });
  }

  async function evaluate(id: string) {
    const record = repo.read(id);
    if (!record || record.project.removedAt !== null || !allows(record.project.id, "impl")) return;
    if (
      record.issue.state !== "implementing" &&
      !(
        record.issue.state === "stopped" &&
        record.context.stoppedFrom === "implementing" &&
        record.issue.stopReason === "usage_limit"
      )
    )
      return;
    const all = stageConversations(id);
    if (all.some((c) => activeStates.includes(c.runState))) return;
    const conversation = all.find((c) => c.kind === "impl" && c.closedAt === null);
    const messages = conversation ? runtime.store.events(conversation.id) : [];
    const stop = messages.findLast((event) => event.type === "stopped");
    if (record.issue.state === "stopped") {
      if (
        conversation?.runState === "usage_limited" &&
        stop &&
        repo.now() >=
          (conversation.resetsAt === null
            ? stop.createdAt + 15 * 60_000
            : conversation.resetsAt + 60_000)
      )
        await runtime.resume(conversation.id, "usage_limit");
      return;
    }
    if (record.context.hasWithdrawnDependencies) {
      const result = repo.transaction((flow) =>
        moveStateWithin(flow, { issueId: id, trigger: "dependency_withdrawn" }, repo.now()),
      );
      if (result.kind === "moved") notices.publish(result.notice);
      return;
    }
    const revision = record.events.at(-1)?.seq;
    const origin = implementationOrigin(record.events);
    if (!origin || pendingImplementationFix(record.events)) return;
    const input = messages.findLast(
      (event) => event.type === "user_message" && event.createdAt >= origin.createdAt,
    );
    const started = record.events.findLast(
      (event) => event.seq > origin.seq && event.type === "ai_started",
    );
    if (!input && !started) {
      const reservation = runtime.store.reserveProjectRun(record.project.id);
      try {
        let c = conversation;
        if (!c) {
          const created = await runtime.start({
            kind: "impl",
            issueId: id,
            projectId: record.project.id,
            cwd: record.project.path,
            title: `#${record.issue.number} の実装`,
          });
          if (created.isErr()) return;
          c = runtime.store.get(created.value.conversationId) ?? undefined;
        }
        if (!c) return;
        const tree = await prepare(id, c.id, () => runtime.closing || !allows(c.projectId, "impl"));
        if (tree.isOk())
          await deliver(c, id, await instruction(id, tree.value), "start", revision, tree.value);
      } finally {
        reservation.release();
      }
      return;
    }
    if (!conversation) return;
    if (
      conversation.runState === "stopped" &&
      conversation.stopReason === "restarted" &&
      stop?.type === "stopped" &&
      stop.payload.previous_run_state !== "waiting_answer"
    ) {
      await deliver(conversation, id, restartInstruction, "restart", revision);
      return;
    }
    const change = record.events.findLast((event) => event.type === "state_changed");
    if (
      change &&
      (change.payload as { cause?: string }).cause === "dependency_cleared" &&
      (!started || started.seq < change.seq) &&
      (!input || input.createdAt < change.createdAt) &&
      (stop?.type !== "stopped" ||
        stop.payload.reason !== "user" ||
        stop.payload.flow_trigger === "dependency_withdrawn")
    ) {
      await deliver(
        conversation,
        id,
        "依存先の取り下げが解消しました。止まったところから続けてください",
        "resume_dependency",
        revision,
      );
      return;
    }
    if (
      conversation.runState !== "idle" ||
      !started ||
      input?.type !== "user_message" ||
      input.payload.origin !== "flow" ||
      record.events.some(
        (event) =>
          event.seq > started.seq &&
          [
            "ready_for_merge",
            "ci_failed",
            "implementation_done",
            "needs_human_reported",
            "merge_allowed",
          ].includes(event.type),
      )
    )
      return;
    const end = messages.findLast((event) => event.type === "turn_end");
    if (end?.type !== "turn_end" || end.payload.subtype !== "success" || end.seq <= input.seq)
      return;
    if (record.events.some((event) => event.type === "report_nudged" && event.seq > started.seq)) {
      const result = repo.transaction((flow) =>
        moveStateWithin(
          flow,
          { issueId: id, trigger: "no_report", detail: "結果の報告が無いまま AI が番を終えました" },
          repo.now(),
        ),
      );
      if (result.kind === "moved") notices.publish(result.notice);
    } else {
      await deliver(
        conversation,
        id,
        "この issue の結果を report_ready_for_merge で報告してください。人の判断が要るときは report_needs_human で報告してください",
        "nudge",
        revision,
      );
    }
  }

  function claim(
    projectId: string,
    checkParents: (
      projectId: string,
      flow: IssueRepositoryPort,
      data: IssueDataRepository,
    ) => { notices: Parameters<IssueNoticePort["publish"]>[0][]; uncertain: Set<string> },
  ) {
    const outcome = repo.transaction((flow, data) => {
      const parents = checkParents(projectId, flow, data);
      const project = repo.project(projectId);
      if (!project || project.removedAt !== null || !allows(projectId, "impl")) return parents;
      const rows = data.all(projectId);
      const links = new Map(data.graph(projectId).map((row) => [row.number, row]));
      const ids = new Map(rows.map((row) => [row.number, row.id]));
      const busy = new Set(
        runtime.store
          .list()
          .filter(
            (c) =>
              activeStates.includes(c.runState) && ["triage", "design", "impl"].includes(c.kind),
          )
          .map((c) => c.issueId),
      );
      const input: ImplementationCandidate[] = rows.map((row) => {
        const dependsOn =
          links.get(row.number)?.dependsOn.map((number) => ids.get(number) ?? "") ?? [];
        return {
          ...row,
          busy:
            busy.has(row.id) ||
            parents.uncertain.has(row.id) ||
            dependsOn.some((id) => parents.uncertain.has(id)),
          dependsOn,
          stoppedFrom:
            row.state === "stopped"
              ? (flow.contextOf(flow.getIssue(row.id)!).stoppedFrom ?? null)
              : null,
        };
      });
      const selected = implementationQueue(input, true, project.implConcurrency);
      const noticesToPublish = parents.notices;
      for (const id of selected.withdrawn) {
        const moved = moveStateWithin(
          flow,
          { issueId: id, trigger: "dependency_withdrawn" },
          repo.now(),
        );
        if (moved.kind === "moved") noticesToPublish.push(moved.notice);
      }
      for (const id of selected.start) {
        const moved = moveStateWithin(
          flow,
          {
            issueId: id,
            trigger: "impl_started",
            facts: { hasCapacity: true, stageEnabled: true },
          },
          repo.now(),
        );
        if (moved.kind === "moved") {
          data.update(id, { prUrl: null });
          const stage = data.append(id, "stage_changed", { stage: "implement" }, repo.now());
          noticesToPublish.push({ ...moved.notice, seq: stage.seq });
        }
      }
      return { notices: noticesToPublish, uncertain: parents.uncertain };
    });
    for (const notice of outcome.notices) notices.publish(notice);
    return {
      selected: outcome.notices.map(({ issue_id }) => issue_id),
      retry: outcome.uncertain.size > 0,
    };
  }
  return {
    claim,
    evaluate,
    prepare,
    instruction,
    repository,
    attach,
    activeTree,
    headAt: (path: string) => git.headAt(path, "HEAD"),
    comparisonBase: (path: string, head: string, baseTip: string | null) =>
      git.comparisonBase(path, head, baseTip),
    sameChange: (
      path: string,
      previous: { base: string; head: string },
      current: { base: string; head: string },
    ) => git.sameChange(path, previous, current),
    protect: (project: StageSnapshot["project"], tree: ImplementationTree, head: string) =>
      git.protect(
        project,
        { path: tree.path, branch: tree.branch, head },
        trees.lockObserver(tree.id),
      ),
  };
}
