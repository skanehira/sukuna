import { join, basename } from "node:path";
import { err, ok } from "neverthrow";
import { validWorktreeName, WORKTREE_NAME_RULE } from "../domain/worktree-rules";
import {
  WORKTREE_CONFLICT,
  type WorktreeDependencies,
  type WorktreeRecord,
} from "../domain/worktree-ports";
import { describeWorktree } from "./list-worktrees";

export async function createWorktree(projectId: string, name: string, deps: WorktreeDependencies) {
  if (!validWorktreeName(name))
    return err({ code: "invalid_input" as const, message: WORKTREE_NAME_RULE });
  const snapshot = deps.repository.snapshot(projectId);
  if (snapshot.isErr()) return err(snapshot.error);
  const { project } = snapshot.value;
  const path = join(project.path, ".claude/worktrees", name);
  const listed = await deps.git.list(project.path);
  if (listed.isErr()) return err(listed.error);
  const exists = await deps.git.exists(path);
  if (exists.isErr()) return err(exists.error);
  if (
    exists.value ||
    listed.value.some((entry) => basename(entry.path) === name || entry.branch === name)
  )
    return err(WORKTREE_CONFLICT);
  const branch = await deps.git.branchExists(project.path, name);
  if (branch.isErr()) return err(branch.error);
  const excluded = await deps.git.exclude(project.path);
  if (excluded.isErr()) return err(excluded.error);
  let start = project.defaultBranch;
  let notice: string | null = null;
  if (project.usesGithub && !branch.value) {
    const fetched = await deps.git.fetch(project.path, project.defaultBranch);
    if (fetched.isOk()) start = `origin/${project.defaultBranch}`;
    else notice = "GitHub から取得できなかったので、手元の既定ブランチから作りました";
  }
  const record: WorktreeRecord = {
    id: deps.id(),
    projectId,
    path,
    branch: name,
    branchCreated: !branch.value,
    origin: "user",
    issueId: null,
  };
  const reserved = deps.repository.reserve(record);
  if (reserved.isErr()) return err(reserved.error);
  const created = await deps.git.add(project.path, path, name, branch.value ? null : start);
  if (created.isErr()) {
    const abandoned = deps.repository.abandon(record.id, deps.now());
    return err(abandoned.isErr() ? abandoned.error : created.error);
  }
  const after = await deps.git.list(project.path);
  if (after.isErr()) return err(after.error);
  const entry = after.value.find((entry) => entry.path === path);
  if (!entry)
    return err({
      code: "worktree_failed" as const,
      message: "作った worktree が見つかりませんでした",
    });
  const described = await describeWorktree(snapshot.value, entry, record, deps);
  if (described.isErr()) return err(described.error);
  return ok({ ...described.value.item, notice });
}
