import { dirname, join } from "node:path";
import { err, ok } from "neverthrow";
import { issueConflict, type IssueDataRepository } from "../../../../shared/issue/ports";
import { worktreeSafety } from "../../../../shared/workspace/worktree-safety";
import type { ConversationRuntime } from "../../conversation/usecase/runtime";
import { activeStates } from "../../conversation/usecase/runtime";
import type { IssueNoticePort, IssueRepositoryPort } from "../domain/ports";
import type { StageRepository, StageSnapshot } from "../domain/stage-ports";
import type {
  ImplementationGit,
  ImplementationGithub,
  ImplementationTerminalCleanup,
  ImplementationTree,
  ImplementationTrees,
} from "../domain/impl-ports";
import type { createImplementationStart } from "./start-implementation";
import { stateChange } from "../domain/evaluate";
import {
  completedPr,
  implementationApproval,
  implementationPrUrl,
  implementationReady,
  issueHistoryPoint,
  readyDetails,
} from "../domain/impl-history";
import { parentClosing } from "../domain/parent-closing";
import { moveStateWithin } from "./move-state";

type MergeReport = {
  source: "agent" | "github";
  conversationId?: string;
  prUrl?: string;
  mergeCommit?: string;
  summary: string;
};

const fail = (message: string) =>
  err({
    code: "conflict" as const,
    message: `merge を確かめられませんでした: ${message}。merge の手順を見直してから、もう一度報告してください`,
  });
const closed = (record: StageSnapshot) => ["done", "withdrawn"].includes(record.issue.state);

function isKept(event: StageSnapshot["events"][number], worktreeId: string) {
  if (event.type !== "worktree_kept") return false;
  const payload = event.payload as { worktreeId?: string; awaitingTerminal?: boolean };
  return payload?.worktreeId === worktreeId && payload.awaitingTerminal !== true;
}

export function createImplementationCompletion(deps: {
  repo: StageRepository;
  runtime: ConversationRuntime;
  notices: IssueNoticePort;
  trees: ImplementationTrees;
  git: ImplementationGit;
  terminals: ImplementationTerminalCleanup;
  gh: ImplementationGithub;
  start: ReturnType<typeof createImplementationStart>;
  logFailure: (error: unknown, issueId: string) => void;
  schedule: (projectId: string) => void;
  defer: (projectId: string) => void;
  designCleanupFailed: (id: string, error: unknown) => void;
}) {
  const { repo, runtime, notices, trees, git, gh, start, logFailure, terminals } = deps;
  const external = new Set<string>();

  function checkParentsWithin(
    projectId: string,
    flow: IssueRepositoryPort,
    data: IssueDataRepository,
  ) {
    const noticesToPublish: Parameters<IssueNoticePort["publish"]>[0][] = [];
    const uncertain = new Set<string>();
    const members = data.all(projectId);
    const children = new Map<string, string[]>();
    for (const member of members) {
      if (member.parentId === null) continue;
      const siblings = children.get(member.parentId) ?? [];
      siblings.push(member.id);
      children.set(member.parentId, siblings);
    }
    const pendingChildren = new Map([...children].map(([id, ids]) => [id, ids.length]));
    const ready = members.filter(({ id }) => !children.has(id)).map(({ id }) => id);
    for (const id of ready) {
      const parent = data.get(id);
      if (!parent) continue;
      const descendants =
        children.get(id)?.flatMap((child) => {
          const latest = data.get(child);
          return latest ? [latest] : [];
        }) ?? [];
      const trigger = parentClosing(
        parent.state,
        descendants.map((child) => child.state),
      );
      const reopened =
        trigger === "child_reopened" &&
        descendants.some(
          (child) =>
            !["done", "withdrawn"].includes(child.state) &&
            repo
              .events(child.id)
              .some(
                (event) =>
                  event.createdAt >= (parent.closedAt ?? 0) &&
                  ["reopen", "reopened_for_fix", "child_reopened"].includes(
                    stateChange(event)?.cause ?? "",
                  ),
              ),
        );
      if (descendants.some((child) => uncertain.has(child.id))) {
        uncertain.add(id);
      } else if (trigger === "children_closed" || reopened) {
        const moved = moveStateWithin(
          flow,
          { issueId: id, trigger: reopened ? "child_reopened" : "children_closed" },
          repo.now(),
        );
        if (moved.kind === "moved") noticesToPublish.push(moved.notice);
        else uncertain.add(id);
      }
      if (parent.parentId) {
        const remaining = (pendingChildren.get(parent.parentId) ?? 0) - 1;
        pendingChildren.set(parent.parentId, remaining);
        if (remaining === 0) ready.push(parent.parentId);
      }
    }
    return { notices: noticesToPublish, uncertain };
  }

  function checkParents(projectId: string) {
    const outcome = repo.transaction((flow, data) => checkParentsWithin(projectId, flow, data));
    for (const notice of outcome.notices) notices.publish(notice);
  }

  function currentClosed(record: StageSnapshot) {
    const current = repo.read(record.issue.id);
    return Boolean(
      current &&
      closed(current) &&
      issueHistoryPoint(current.events) === issueHistoryPoint(record.events),
    );
  }

  function waitingForWithdrawalStops(record: StageSnapshot) {
    return (
      record.issue.state === "withdrawn" &&
      runtime.store
        .list()
        .some(
          (c) =>
            c.issueId === record.issue.id &&
            ["triage", "design", "impl"].includes(c.kind) &&
            activeStates.includes(c.runState),
        )
    );
  }

  async function cleanup(record: StageSnapshot, verifiedHead?: string) {
    if (!closed(record) || waitingForWithdrawalStops(record)) return;
    const { project, issue } = record;
    const live = trees.list(project.id).filter((row) => row.issueId === issue.id);
    if (issue.state === "withdrawn" && terminals.available)
      live.push(...trees.ownedDesignForCleanup(project.id, issue.id));
    for (const tree of live) {
      if (record.events.some((event) => isKept(event, tree.id))) continue;
      try {
        await removeOrKeep(record, tree, verifiedHead);
      } catch (error) {
        if (tree.branch.startsWith("sukuna/design-")) deps.designCleanupFailed(issue.id, error);
        else logFailure(error, issue.id);
      }
    }
  }

  function finishWithdrawal(id: string, withdrawalSeq: number) {
    const record = repo.read(id);
    if (
      !record ||
      record.issue.state !== "withdrawn" ||
      issueHistoryPoint(record.events) !== withdrawalSeq
    )
      return "owned" as const;
    const projectId = record.project.id;
    deps.schedule(projectId);
    if (!trees.ownedDesignForCleanup(projectId, id).length) return "legacy" as const;
    return terminals.available ? ("owned" as const) : ("awaiting_terminal" as const);
  }

  async function removeOrKeep(
    record: StageSnapshot,
    tree: ImplementationTree,
    verifiedHead?: string,
  ) {
    if (waitingForWithdrawalStops(record)) return;
    const { project, issue } = record;
    const design = tree.branch.startsWith("sukuna/design-");
    const lease = trees.activity.acquire([tree.id]);
    if (lease.isErr()) {
      if (design && lease.error.code === "conflict") deps.defer(project.id);
      return;
    }
    const stillClosed = () => currentClosed(record);
    const append = (
      type: "worktree_kept" | "worktree_removed",
      payload: object,
      removed: boolean,
    ) => {
      const event = repo.transaction(() => {
        if (!stillClosed()) return;
        if (removed && !trees.detach(tree, project.path, repo.now())) return;
        if (!removed && "path" in payload && payload.path !== tree.path)
          trees.resetLocation(tree, project.path);
        return repo.append(issue.id, type, {
          worktreeId: tree.id,
          path: tree.path,
          ...(removed && design ? { retainedBranch: tree.branch } : {}),
          ...payload,
        });
      }, lease.value);
      if (event)
        notices.publish({
          kind: "issue",
          issue_id: issue.id,
          project_id: project.id,
          seq: event.seq,
        });
    };
    let retry = false;
    let uncommittedFiles = 0;
    let unpushedCommits = 0;
    const kept = (path = tree.path) =>
      append("worktree_kept", { path, uncommittedFiles, unpushedCommits }, false);
    try {
      if (!stillClosed() || !trees.forCleanup(project.id, tree.id)) return;
      if (repo.events(issue.id).some((event) => isKept(event, tree.id))) return;
      const root = await git.canonical(project.path);
      const identity = tree.identity;
      if (dirname(tree.path) !== join(root, ".claude/worktrees") || !identity) return kept();
      const physical =
        tree.cleanupPath && git.owns(tree.cleanupPath, identity) ? tree.cleanupPath : tree.path;
      if (!git.owns(physical, identity)) {
        if (tree.cleanupPath && !git.registrationExists(identity))
          return append("worktree_removed", {}, true);
        if (design && !git.registrationExists(identity)) {
          const exists = await git.exists(physical);
          const listed = await git.list(project.path);
          if (
            exists.isOk() &&
            !exists.value &&
            listed.isOk() &&
            !listed.value.some((entry) => entry.path === physical)
          )
            return append("worktree_removed", {}, true);
        }
        return kept();
      }
      const listed = await git.list(project.path);
      if (listed.isErr()) {
        kept(physical);
        if (design) throw new Error(listed.error.message);
        return;
      }
      const entry = listed.value.find((row) => row.path === physical);
      if (!entry || entry.branch !== tree.branch) return kept(physical);
      const status = await git.status(project, entry);
      if (status.isErr()) {
        kept(physical);
        if (design) throw new Error(status.error.message);
        return;
      }
      if (status.value.branch !== tree.branch) return kept(physical);
      const urls = record.events.flatMap((event) => {
        const payload = event.payload as { prUrl?: string | null; previousPrUrl?: string | null };
        if (event.type === "reopened_for_fix" && payload.previousPrUrl)
          return [payload.previousPrUrl];
        if (
          ["ready_for_merge", "implementation_done", "design_pr_created"].includes(event.type) &&
          payload.prUrl
        )
          return [payload.prUrl];
        return [];
      });
      if (issue.prUrl) urls.push(issue.prUrl);
      const mergedPrHeads = verifiedHead ? [verifiedHead] : [];
      if (
        project.usesGithub &&
        status.value.unpushedCount > 0 &&
        !mergedPrHeads.includes(status.value.head)
      )
        mergedPrHeads.push(...(await git.mergedPrHeads(project.path, [...new Set(urls)])));
      const safety = (current = status.value) =>
        worktreeSafety({
          main: false,
          origin: "flow",
          issue: { number: issue.number, state: issue.state },
          conversations: runtime.store
            .list()
            .filter(
              (c) =>
                c.cwd === tree.path &&
                (issue.state === "withdrawn" ||
                  c.issueId !== issue.id ||
                  !["triage", "design", "impl"].includes(c.kind)),
            ),
          locked: entry.locked,
          ...current,
          mergedPrHeads,
        });
      uncommittedFiles = status.value.uncommittedCount;
      const decision = safety();
      unpushedCommits = decision.unpushedCount;
      if (!decision.allowed || !stillClosed()) return kept(physical);
      const lockObserver = trees.lockObserver(tree.id);
      const protection = await git.protect(
        project,
        {
          path: physical,
          head: status.value.head,
          branch: tree.branch,
        },
        lockObserver,
      );
      if (protection.isErr()) return kept(physical);
      let cleanupRemoved = false;
      try {
        if (!stillClosed()) return;
        if (!safety().allowed) return kept();
        if (!git.owns(physical, identity)) return kept(physical);
        if (physical === tree.path) {
          const directoryKey = await git.directoryKey(physical);
          if (!directoryKey || !git.owns(physical, identity)) return kept();
          const confirmation = await terminals.close(tree.id, tree.path, directoryKey);
          retry = confirmation === "reconnected";
          if (confirmation !== "closed") return;
        }
        if (!stillClosed()) return;
        if (!git.owns(physical, identity)) return kept();
        const latest = await git.status(project, entry);
        if (latest.isErr()) {
          kept(physical);
          if (design) throw new Error(latest.error.message);
          return;
        }
        if (
          latest.value.head !== status.value.head ||
          latest.value.branch !== tree.branch ||
          !git.owns(physical, identity)
        )
          return kept(physical);
        const outcome = safety(latest.value);
        uncommittedFiles = latest.value.uncommittedCount;
        unpushedCommits = outcome.unpushedCount;
        if (!outcome.allowed || !stillClosed()) return kept(physical);
        const removed = await git.removeOwned(
          project.path,
          tree.path,
          identity,
          tree.cleanupPath,
          { head: latest.value.head, branch: tree.branch },
          (path, adminDetached) =>
            repo.transaction(() => trees.planCleanup(tree.id, path, adminDetached), lease.value),
          lockObserver,
        );
        if (removed.isErr()) return kept(removed.error.retainedPath ?? tree.path);
        cleanupRemoved = true;
      } finally {
        await protection.value.release();
      }
      const pendingLocks = trees.forCleanup(project.id, tree.id)?.cleanupLocks;
      if (cleanupRemoved && pendingLocks?.length === 0) append("worktree_removed", {}, true);
    } finally {
      lease.value.release();
      if (retry && !runtime.closing && stillClosed()) deps.schedule(project.id);
    }
  }

  async function complete(id: string, report: MergeReport) {
    const record = repo.read(id);
    if (!record || record.project.removedAt !== null) return err(issueConflict);
    const { issue, project } = record;
    if (
      !(
        issue.state === "implementing" ||
        (report.source === "github" &&
          issue.state === "stopped" &&
          record.context.stoppedFrom === "implementing")
      )
    )
      return err(issueConflict);
    const conversation = runtime.store
      .list()
      .find(
        (row) =>
          row.issueId === id &&
          row.kind === "impl" &&
          row.closedAt === null &&
          (report.conversationId === undefined || report.conversationId === row.id),
      );
    const tree = conversation ? start.activeTree(project.id, conversation.id) : undefined;
    if (!conversation || !tree) return fail("実装の worktree が見つかりません");
    const ready = implementationReady(record.events);
    const binding = readyDetails(ready);
    if (binding && binding.worktreeId !== tree.id)
      return fail("用意した実装の作業場所が変わりました");
    if (
      report.source === "agent" &&
      issue.confirmBeforeMerge &&
      !implementationApproval(record.events, ready)
    )
      return fail("この実装への merge の許可がありません");
    const prUrl = implementationPrUrl(report.prUrl);
    let commit = report.mergeCommit?.toLowerCase();
    let mergedHead: string | undefined;
    let releaseLocal: (() => Promise<void>) | undefined;
    if (project.usesGithub) {
      if (
        !prUrl ||
        binding?.prUrl !== prUrl ||
        implementationPrUrl(issue.prUrl) !== prUrl ||
        completedPr(record.events, prUrl)
      )
        return fail("この実装で用意した PR の URL を指定してください");
      const target = await start.repository(project);
      if (target.isErr()) return fail(target.error.message);
      if (target.value === null) return fail("GitHub のリポジトリが見つかりません");
      const result = await gh.view(
        project.path,
        { repository: target.value, base: project.defaultBranch, branch: tree.branch },
        prUrl,
      );
      if (result.isErr()) return fail(result.error.message);
      if (
        result.value.state !== "MERGED" ||
        !result.value.merge ||
        (commit !== undefined && result.value.merge.toLowerCase() !== commit) ||
        binding.head !== result.value.head.toLowerCase()
      )
        return fail("PR の状態か merge のコミットが一致しません");
      commit = result.value.merge;
      mergedHead = result.value.head;
    } else {
      if (report.prUrl || !commit) return fail("既定ブランチに入れたコミットを指定してください");
      const head = await git.headAt(tree.path, "HEAD");
      if (head.isErr() || head.value.toLowerCase() !== commit)
        return fail("報告したコミットと実装の worktree の先頭が一致しません");
      if (issue.confirmBeforeMerge && binding?.head !== commit)
        return fail("許可したコミットと実装の worktree の先頭が一致しません");
      const tip = await git.headAt(project.path, `refs/heads/${project.defaultBranch}`);
      if (tip.isErr()) return fail(tip.error.message);
      const merged = await git.contains(project.path, tip.value, [commit]);
      if (merged.isErr()) return fail(merged.error.message);
      if (!merged.value) return fail("実装の worktree の先頭が既定ブランチに含まれていません");
      const work = await start.protect(project, tree, head.value);
      if (work.isErr()) return fail("実装の worktree の先頭が変わりました");
      const target = await git.protectTip(
        project.path,
        project.defaultBranch,
        tip.value,
        trees.lockObserver(tree.id),
      );
      if (target.isErr()) {
        await work.value.release();
        return fail("既定ブランチの先頭が変わりました");
      }
      releaseLocal = async () => {
        try {
          await target.value.release();
        } finally {
          await work.value.release();
        }
      };
    }
    const save = () =>
      repo.transaction((flow, data) => {
        const current = repo.read(id);
        if (
          !current ||
          current.project.removedAt !== null ||
          current.project.usesGithub !== project.usesGithub ||
          current.project.defaultBranch !== project.defaultBranch ||
          start.activeTree(project.id, conversation.id)?.id !== tree.id ||
          (report.source === "agent" &&
            current.issue.confirmBeforeMerge &&
            (!implementationApproval(current.events, implementationReady(current.events)) ||
              (!current.project.usesGithub && binding?.head !== commit))) ||
          current.issue.prUrl !== issue.prUrl ||
          current.issue.state !== issue.state ||
          issueHistoryPoint(current.events) !== issueHistoryPoint(record.events) ||
          implementationReady(current.events)?.seq !== implementationReady(record.events)?.seq ||
          (report.source === "github" && isBusy(id))
        )
          return;
        const now = repo.now();
        const moved = moveStateWithin(
          flow,
          {
            issueId: id,
            trigger: "implementation_done",
            facts: { mergeSource: report.source, mergeVerified: true },
          },
          now,
        );
        if (moved.kind !== "moved") return;
        const event = repo.append(id, "implementation_done", {
          prUrl,
          mergeCommit: commit,
          summary: report.summary,
        });
        if (prUrl) data.update(id, { prUrl });
        return { ...moved.notice, seq: event.seq };
      });
    let saved: ReturnType<typeof save>;
    try {
      saved = save();
    } finally {
      await releaseLocal?.();
    }
    if (!saved) return err(issueConflict);
    try {
      const finished = repo.read(id);
      if (finished) await cleanup(finished, mergedHead);
      checkParents(project.id);
    } finally {
      notices.publish({ ...saved, seq: repo.events(id).at(-1)?.seq ?? saved.seq });
    }
    return ok("完了にしました。番を終えてください");
  }

  async function recoverBeforeConversations() {
    for (const tree of trees.pending()) {
      const record = repo.read(tree.issueId);
      if (!record) continue;
      const lease = trees.activity.acquire([tree.id]);
      if (lease.isErr()) continue;
      try {
        if (!closed(record)) {
          git.recoverLocks(tree);
          repo.transaction(() => trees.clearLocks(tree.id), lease.value);
          continue;
        }
        const result = await git.recoverOwned(record.project, tree);
        repo.transaction(() => {
          if (!currentClosed(record)) return;
          const now = repo.now();
          if (result.state === "restored") {
            trees.planCleanup(tree.id, null, false);
            trees.clearLocks(tree.id);
            return;
          }
          if (result.state === "removed") {
            if (trees.detach(tree, record.project.path, now))
              repo.append(tree.issueId, "worktree_removed", {
                worktreeId: tree.id,
                path: tree.path,
                ...(tree.branch.startsWith("sukuna/design-")
                  ? { retainedBranch: tree.branch }
                  : {}),
              });
            return;
          }
          trees.resetLocation(tree, record.project.path);
          trees.planCleanup(tree.id, null, false);
          trees.clearLocks(tree.id);
          if (!record.events.some((event) => isKept(event, tree.id)))
            repo.append(tree.issueId, "worktree_kept", {
              worktreeId: tree.id,
              path: result.path ?? tree.path,
              uncommittedFiles: 0,
              unpushedCommits: 0,
            });
        }, lease.value);
      } catch (error) {
        logFailure(error, tree.issueId);
      } finally {
        lease.value.release();
      }
    }
  }

  async function cleanupIfClosed(id: string) {
    const record = repo.read(id);
    if (record && closed(record)) await cleanup(record);
  }

  function isBusy(id: string) {
    return runtime.store
      .list()
      .some((c) => c.issueId === id && c.kind === "impl" && activeStates.includes(c.runState));
  }

  async function observe(id: string) {
    if (!external.has(id) || isBusy(id)) return;
    external.delete(id);
    const record = repo.read(id);
    if (!record?.issue.prUrl) return;
    await complete(id, {
      source: "github",
      prUrl: record.issue.prUrl,
      summary: "GitHub で merge されました",
    });
  }

  return {
    complete,
    observe,
    noteExternalMerge: (id: string) => external.add(id),
    cleanup,
    finishWithdrawal,
    cleanupIfClosed,
    recoverBeforeConversations,
    checkParentsWithin,
  };
}
