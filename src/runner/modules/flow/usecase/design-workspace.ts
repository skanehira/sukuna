import { dirname, join, basename } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { activeStates, type ConversationRuntime } from "../../conversation/usecase/runtime";
import {
  designConflict,
  designNotFound,
  designPrCreatedSchema,
  type DesignError,
} from "../../../../shared/api/design";
import type { DesignRecord } from "../../../../shared/design/records";
import {
  designInternal,
  type DesignFlowDependencies,
  type DesignWorktree,
} from "../domain/design-ports";

export function createDesignWorkspace(deps: DesignFlowDependencies, runtime: ConversationRuntime) {
  const creating = new Map<string, Promise<Result<DesignWorktree, DesignError>>>();
  function workspace(input: {
    issueId: string;
    conversationId: string;
  }): Promise<Result<DesignWorktree, DesignError>> {
    const pending = creating.get(input.issueId);
    if (pending) return Promise.resolve(err(designConflict));
    const job = prepare(input).finally(() => creating.delete(input.issueId));
    creating.set(input.issueId, job);
    return job;
  }

  async function prepare({ issueId, conversationId }: { issueId: string; conversationId: string }) {
    const record = deps.repo.read(issueId);
    if (!record) return err(designNotFound);
    if (
      record.conversation?.id !== conversationId ||
      !["design", "stopped"].includes(record.issue.state)
    )
      return err(designConflict);
    const { project } = record;
    const list = await deps.workspace.list(project.path);
    if (list.isErr()) return failed(record, conversationId, list.error.message);
    const old = deps.repo.findTree(issueId, project.id, record.issue.number);
    if (old) {
      const oldPath = await deps.git.canonical(old.path);
      if (list.value.some((entry) => entry.path === oldPath && entry.branch === old.branch)) {
        const lease = deps.activity.acquire([old.id]);
        if (lease.isErr()) return err(lease.error);
        try {
          return attach(record, conversationId, old, lease.value);
        } finally {
          lease.value.release();
        }
      }
      const exists = await deps.workspace.exists(old.path);
      if (exists.isErr()) return failed(record, conversationId, exists.error.message);
      if (exists.value)
        return failed(record, conversationId, "記録した worktree のブランチが変わりました");
      deps.repo.abandonTree(old.id, deps.clock.now());
    }
    const excluded = await deps.workspace.exclude(project.path);
    if (excluded.isErr()) return failed(record, conversationId, excluded.error.message);
    const fetched =
      project.usesGithub && (await deps.workspace.fetch(project.path, project.defaultBranch));
    const start =
      fetched && fetched.isOk()
        ? `refs/remotes/origin/${project.defaultBranch}`
        : `refs/heads/${project.defaultBranch}`;
    const root = join(await deps.git.canonical(project.path), ".claude", "worktrees");
    const prefix = `design-${record.issue.number}`;
    for (let suffix = 1; ; suffix += 1) {
      const name = suffix === 1 ? prefix : `${prefix}-${suffix}`;
      const path = join(root, name);
      const branch = `sukuna/${name}`;
      if (
        list.value.some((entry) => basename(entry.path) === name) ||
        deps.repo.pathTaken(project.id, path)
      )
        continue;
      const pathExists = await deps.workspace.exists(path);
      if (pathExists.isErr()) return failed(record, conversationId, pathExists.error.message);
      if (pathExists.value) continue;
      const branchExists = await deps.workspace.branchExists(project.path, branch);
      if (branchExists.isErr()) return failed(record, conversationId, branchExists.error.message);
      if (branchExists.value) continue;
      const tree = { id: deps.clock.id(), path, branch };
      const lease = deps.activity.acquire([tree.id]);
      if (lease.isErr()) return err(lease.error);
      try {
        const reserved = deps.transaction((repo) => {
          const latest = repo.read(issueId);
          if (
            !latest ||
            latest.issue.state !== record.issue.state ||
            latest.conversation?.id !== conversationId ||
            repo.pathTaken(project.id, path)
          )
            return false;
          repo.saveTree(record, tree);
          return true;
        }, lease.value);
        if (!reserved) return err(designConflict);
        const created = await deps.workspace.add(project.path, path, branch, start);
        if (created.isErr()) {
          deps.repo.abandonTree(tree.id, deps.clock.now());
          return failed(record, conversationId, created.error.message, lease.value);
        }
        return attach(record, conversationId, tree, lease.value);
      } finally {
        lease.value.release();
      }
    }
  }

  function attach(
    record: DesignRecord,
    conversationId: string,
    tree: DesignWorktree,
    reservation?: Parameters<DesignFlowDependencies["transaction"]>[1],
  ) {
    const result = deps.transaction((repo) => {
      reservation?.acquire([tree.id]);
      const latest = repo.read(record.issue.id);
      if (
        latest?.issue.state !== record.issue.state ||
        latest.conversation?.id !== conversationId ||
        activeStates.includes(runtime.store.get(conversationId)?.runState ?? "idle")
      )
        return false;
      return repo.attachTree(record, conversationId, tree);
    }, reservation);
    return result ? ok({ id: tree.id, path: tree.path, branch: tree.branch }) : err(designConflict);
  }

  function failed(
    record: DesignRecord,
    conversationId: string,
    detail: string,
    reservation?: Parameters<DesignFlowDependencies["transaction"]>[1],
  ) {
    const message = `設計の worktree を作れませんでした: ${detail.split(/\r?\n/)[0]}。状態を確認してから再開してください`;
    let notice: ReturnType<typeof deps.repo.append> | null = null;
    runtime.record(
      conversationId,
      [{ type: "stopped", payload: { reason: "error", detail: message } }],
      () => {
        notice = deps.transaction((repo) => {
          if (!repo.move(record, "worktree_failed", deps.clock.now(), message, false)) return null;
          const updated = repo.read(record.issue.id)!;
          const last = updated.events.at(-1)!;
          return {
            kind: "issue",
            issue_id: record.issue.id,
            project_id: record.project.id,
            seq: last.seq,
          };
        }, reservation);
      },
      () => deps.repo.read(record.issue.id)?.issue.state === record.issue.state,
    );
    if (notice) deps.notices.publish(notice);
    return err(designInternal(message));
  }

  async function cleanup(record: DesignRecord, mergedHead?: string): Promise<void> {
    const tree = deps.repo.findTree(record.issue.id, record.project.id, record.issue.number);
    if (!tree) return;
    const { project, issue } = record;
    const lease = deps.activity.acquire([tree.id]);
    const now = () => deps.clock.now();
    let files = 0;
    let unpushed = 0;
    let removed = false;
    const withdrawal = issue.state === "withdrawn";
    const withdrawalSeq = record.events.findLast((event) => event.type === "state_changed")?.seq;
    const sameWithdrawal = () => {
      const latest = deps.repo.read(issue.id);
      return (
        !withdrawal ||
        (latest?.issue.state === "withdrawn" &&
          latest.events.findLast((event) => event.type === "state_changed")?.seq === withdrawalSeq)
      );
    };
    const sameCleanup = () =>
      sameWithdrawal() && deps.repo.findTree(issue.id, project.id, issue.number)?.id === tree.id;
    try {
      if (lease.isErr() || !sameCleanup()) return;
      const reservation = lease.value;
      const root = await deps.git.canonical(project.path);
      const path = await deps.git.canonical(tree.path);
      if (dirname(path) !== join(root, ".claude", "worktrees") || path !== tree.path) return;
      const locate = async () => {
        const listed = await deps.workspace.list(project.path);
        const present = await deps.workspace.exists(path);
        if (listed.isErr()) throw new Error(listed.error.message);
        if (present.isErr()) throw new Error(present.error.message);
        return { entry: listed.value.find((item) => item.path === path), present: present.value };
      };
      const currentLocation = await locate();
      const { entry, present } = currentLocation;
      const detach = () =>
        deps.transaction((repo) => repo.detachTree(record, tree, now()), reservation);
      if (!entry) {
        if (present) return;
        const confirmed = await locate();
        if (confirmed.entry || confirmed.present || !sameCleanup()) return;
        detach();
        removed = true;
        return;
      }
      if (entry.branch !== tree.branch) return;
      const current = await deps.workspace.status(project, entry);
      if (current.isErr()) throw new Error(current.error.message);
      if (current.value.branch !== tree.branch) return;
      files = current.value.uncommittedCount;
      if (mergedHead === current.value.head) return;
      unpushed = current.value.unpushedCount;
      if (!unpushed) return;
      const urls = record.events.flatMap((event) => {
        const parsed = designPrCreatedSchema.safeParse(event.payload);
        return event.type === "design_pr_created" && parsed.success ? [parsed.data.prUrl] : [];
      });
      if (issue.prUrl) urls.push(issue.prUrl);
      if (urls.length) {
        const published = await deps.workspace.mergedPrHeads(project.path, [...new Set(urls)]);
        if (published.includes(current.value.head)) unpushed = 0;
      }
    } catch (error) {
      deps.log(error);
      if (withdrawal)
        deps.alert(issue.id, "取り下げは保存しましたが、設計の作業場所を確認できませんでした。");
    } finally {
      if (lease.isOk()) lease.value.release();
      const notice = sameWithdrawal()
        ? deps.transaction((repo) =>
            repo.append(
              record,
              removed ? "worktree_removed" : "worktree_kept",
              removed
                ? { worktreeId: tree.id, path: tree.path, retainedBranch: tree.branch }
                : {
                    worktreeId: tree.id,
                    path: tree.path,
                    uncommittedFiles: files,
                    unpushedCommits: unpushed,
                  },
              now(),
            ),
          )
        : null;
      if (notice) deps.notices.publish(notice);
    }
  }
  return { workspace, cleanup };
}
