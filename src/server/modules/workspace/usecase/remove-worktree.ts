import { err, ok, type Result } from "neverthrow";
import {
  worktreeSafety,
  type WorktreeSafetyInput,
} from "../../../../shared/workspace/worktree-safety";
import {
  WORKTREE_CHANGED,
  type WorktreeDependencies,
  type WorktreeError,
  type WorktreeRemovalPlan,
} from "../domain/worktree-ports";
import { describeWorktree } from "./list-worktrees";

export async function removeWorktree(id: string, deps: WorktreeDependencies) {
  const found = deps.repository.find(id, true);
  if (found.isErr()) return err(found.error);
  const record = found.value;
  const snapshot = deps.repository.snapshot(record.projectId);
  if (snapshot.isErr()) return err(snapshot.error);
  const state = snapshot.value;
  const { project } = state;
  const access = deps.activity.acquire([record.id]);
  if (access.isErr()) return err(access.error);
  try {
    return await removeReserved();
  } finally {
    access.value.release();
  }
  async function removeReserved() {
    const stored = await deps.removals.load(project, id);
    if (stored.isErr()) return err(stored.error);
    let plan = stored.value;
    if (record.removedAt != null && !plan)
      return err({ code: "not_found" as const, message: "worktree がありません" });
    const listed = await deps.git.list(project.path);
    if (listed.isErr()) return err(listed.error);
    const entry = listed.value.find((entry) => entry.path === record.path);
    const present = await deps.git.exists(record.path);
    if (present.isErr()) return err(present.error);
    if ((plan?.worktreeRemoved && (present.value || entry)) || (!entry && present.value))
      return err(WORKTREE_CHANGED);
    const identity = await deps.removals.identity(project, record.path);
    if (identity.isErr()) return err(identity.error);
    if (
      entry &&
      record.path !== project.path &&
      (!identity.value || (plan && plan.identity !== identity.value))
    )
      return err(WORKTREE_CHANGED);
    const gone = !entry && !present.value;
    let input: WorktreeSafetyInput = {
      main: record.path === project.path,
      origin: record.origin,
      issue: state.issues.find((issue) => issue.id === record.issueId) ?? null,
      conversations: state.conversations.filter((conversation) => conversation.cwd === record.path),
      locked: null,
      uncommittedCount: 0,
      uncommittedSample: [],
      unpushedCount: 0,
      head: "",
      mergedPrHeads: [],
    };
    let current: { path: string; head: string; branch: string | null } | null = null;
    if (!gone) {
      const described = await describeWorktree(state, entry!, record, deps);
      if (described.isErr()) return err(described.error);
      input = described.value.safetyInput;
      if (!described.value.item.missing)
        current = { path: record.path, head: input.head, branch: described.value.item.branch };
    }
    const latest = deps.repository.snapshot(project.id);
    if (latest.isErr()) return err(latest.error);
    const issue = latest.value.issues.find((issue) => issue.id === record.issueId) ?? null;
    input = {
      ...input,
      issue,
      conversations: latest.value.conversations.filter(
        (conversation) => conversation.cwd === record.path,
      ),
    };
    const safety = worktreeSafety(input);
    if (safety.conflict && (!gone || !plan)) return err(safety.conflict);
    const protectedRefs = await deps.git.protect(project, current);
    if (protectedRefs.isErr()) return err(protectedRefs.error);
    let moved: Result<string[], WorktreeError>;
    try {
      if (!gone) {
        const confirmed = deps.repository.snapshot(project.id);
        if (confirmed.isErr()) return err(confirmed.error);
        const safety = worktreeSafety({
          ...input,
          issue: confirmed.value.issues.find((issue) => issue.id === record.issueId) ?? null,
          conversations: confirmed.value.conversations.filter(
            (conversation) => conversation.cwd === record.path,
          ),
        });
        if (safety.conflict) return err(safety.conflict);
      }
      if (!plan) {
        plan = {
          worktreeRemoved: gone,
          identity: identity.value,
        };
      }
      const pending: WorktreeRemovalPlan = {
        ...plan,
        worktreeRemoved: gone,
      };
      const saved = await deps.removals.save(project, id, pending);
      if (saved.isErr()) return err(saved.error);
      plan = pending;
      if (gone && deps.terminals) await deps.terminals.sessions.endAt(record.path);
      if (!gone) {
        const confirmed = deps.repository.snapshot(project.id);
        if (confirmed.isErr()) return err(confirmed.error);
        const latestSafety = worktreeSafety({
          ...input,
          issue: confirmed.value.issues.find((issue) => issue.id === record.issueId) ?? null,
          conversations: confirmed.value.conversations.filter(
            (conversation) => conversation.cwd === record.path,
          ),
        });
        if (latestSafety.conflict) return err(latestSafety.conflict);
        if (deps.terminals) await deps.terminals.sessions.endAt(record.path);
        const removed = present.value
          ? await deps.git.remove(project.path, record.path)
          : await deps.git.prune(project.path);
        if (removed.isErr()) return err(removed.error);
        plan = { ...plan, worktreeRemoved: true };
      }
      const updated = await deps.removals.save(project, id, plan);
      moved = deps.unitOfWork.run((repository) => repository.remove(record, project, deps.now()));
      if (updated.isErr()) return err(updated.error);
    } finally {
      await protectedRefs.value.release();
    }
    if (moved.isErr()) return err(moved.error);
    const cleared = await deps.removals.clear(project, id);
    if (cleared.isErr()) return err(cleared.error);
    return ok({ removedBranch: false as const, movedConversationIds: moved.value });
  }
}
