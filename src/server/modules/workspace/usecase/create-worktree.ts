import { join, basename } from "node:path";
import { err, ok } from "neverthrow";
import {
  defaultWorktreeName,
  validWorktreeName,
  WORKTREE_NAME_RULE,
} from "../domain/worktree-rules";
import {
  WORKTREE_CONFLICT,
  type WorktreeDependencies,
  type WorktreeRecord,
} from "../domain/worktree-ports";
import { describeWorktree } from "./list-worktrees";

export async function createWorktree(
  projectId: string,
  name: string | undefined,
  deps: WorktreeDependencies,
) {
  if (name !== undefined && !validWorktreeName(name))
    return err({ code: "invalid_input" as const, message: WORKTREE_NAME_RULE });
  const snapshot = deps.repository.snapshot(projectId);
  if (snapshot.isErr()) return err(snapshot.error);
  const { project } = snapshot.value;
  const listed = await deps.git.list(project.path);
  if (listed.isErr()) return err(listed.error);
  const occupied = listed.value.flatMap((entry) =>
    entry.branch === null ? [basename(entry.path)] : [basename(entry.path), entry.branch],
  );
  const date = new Date(deps.now());
  let record: WorktreeRecord;
  let base: { start: string; notice: string | null } | undefined;
  let notice: string | null = null;
  const useNextName = (candidate: string) => {
    if (name !== undefined) return false;
    occupied.push(candidate);
    return true;
  };
  for (;;) {
    const candidate = name ?? defaultWorktreeName(date, occupied, []);
    const path = join(project.path, ".claude/worktrees", candidate);
    const exists = await deps.git.exists(path);
    if (exists.isErr()) return err(exists.error);
    if (exists.value || occupied.includes(candidate)) {
      if (useNextName(candidate)) continue;
      return err(WORKTREE_CONFLICT);
    }
    const branch = await deps.git.branchExists(project.path, candidate);
    if (branch.isErr()) return err(branch.error);
    if (branch.value && useNextName(candidate)) continue;
    const excluded = await deps.git.exclude(project.path);
    if (excluded.isErr()) return err(excluded.error);
    let start: string | null = null;
    if (!branch.value) {
      if (!base) {
        base = { start: `refs/heads/${project.defaultBranch}`, notice: null };
        if (project.usesGithub) {
          const fetched = await deps.git.fetch(project.path, project.defaultBranch);
          if (fetched.isOk()) base.start = `refs/remotes/origin/${project.defaultBranch}`;
          else base.notice = "GitHub から取得できなかったので、手元の既定ブランチから作りました";
        }
      }
      ({ start, notice } = base);
    }
    record = {
      id: deps.id(),
      projectId,
      path,
      branch: candidate,
      branchCreated: !branch.value,
      origin: "user",
      issueId: null,
    };
    const reserved = deps.repository.reserve(record);
    if (reserved.isErr()) {
      if (name === undefined && reserved.error.code === "conflict") {
        const latest = deps.repository.snapshot(projectId);
        if (latest.isErr()) return err(latest.error);
        if (latest.value.worktrees.some((existing) => existing.path === path)) {
          occupied.push(candidate);
          continue;
        }
      }
      return err(reserved.error);
    }
    const created = await deps.git.add(project.path, path, candidate, start);
    if (created.isOk()) break;
    const abandoned = deps.repository.abandon(record.id, deps.now());
    if (abandoned.isErr()) return err(abandoned.error);
    if (created.error.code === "conflict" && useNextName(candidate)) continue;
    return err(created.error);
  }
  const after = await deps.git.list(project.path);
  if (after.isErr()) return err(after.error);
  const entry = after.value.find((entry) => entry.path === record.path);
  if (!entry)
    return err({
      code: "worktree_failed" as const,
      message: "作った worktree が見つかりませんでした",
    });
  const described = await describeWorktree(snapshot.value, entry, record, deps);
  if (described.isErr()) return err(described.error);
  return ok({ ...described.value.item, id: record.id, notice });
}
