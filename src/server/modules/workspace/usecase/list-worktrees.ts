import { basename } from "node:path";
import { err, ok } from "neverthrow";
import type { WorktreeItem } from "../../../../shared/api/worktree";
import { worktreeSafety } from "../../../../shared/workspace/worktree-safety";
import type {
  GitWorktree,
  WorktreeDependencies,
  WorktreeRecord,
  WorktreeSnapshot,
} from "../domain/worktree-ports";

export async function describeWorktree(
  snapshot: WorktreeSnapshot,
  entry: GitWorktree,
  record: WorktreeRecord | null,
  deps: WorktreeDependencies,
) {
  const status = await deps.git.status(snapshot.project, entry);
  if (status.isErr()) return err(status.error);
  const issue = snapshot.issues.find((issue) => issue.id === record?.issueId) ?? null;
  const conversations = snapshot.conversations.filter(
    (conversation) => conversation.cwd === entry.path,
  );
  const mergedPrHeads =
    issue && status.value.unpushedCount > 0
      ? await deps.git.mergedPrHeads(snapshot.project.path, issue.prUrls)
      : [];
  const safetyInput = {
    main: entry.path === snapshot.project.path,
    origin: record?.origin ?? ("user" as const),
    issue,
    conversations,
    locked: entry.locked,
    ...status.value,
    head: status.value.head,
    mergedPrHeads,
  };
  const safety = worktreeSafety(safetyInput);
  const item: WorktreeItem = {
    id: safetyInput.main ? null : record!.id,
    name: safetyInput.main ? "main" : basename(entry.path),
    path: entry.path,
    branch: status.value.branch,
    origin: safetyInput.main ? "main" : record!.origin,
    issue: issue
      ? { id: issue.id, number: issue.number, title: issue.title, state: issue.state }
      : null,
    conversations: conversations
      .filter((conversation) => conversation.closedAt === null)
      .map(({ id, title, runState }) => ({ id, title, runState })),
    uncommittedCount: status.value.uncommittedCount,
    uncommittedSample: status.value.uncommittedSample,
    unpushedCount: safety.unpushedCount,
    locked: entry.locked,
    missing: status.value.missing,
    terminalId: null,
  };
  return ok({ item, safety, safetyInput });
}

export async function listWorktrees(projectId: string, deps: WorktreeDependencies) {
  const snapshot = deps.repository.snapshot(projectId);
  if (snapshot.isErr()) return err(snapshot.error);
  const listed = await deps.git.list(snapshot.value.project.path);
  if (listed.isErr()) return err(listed.error);
  const entries = [
    ...listed.value.filter((entry) => entry.path === snapshot.value.project.path),
    ...listed.value.filter((entry) => entry.path !== snapshot.value.project.path),
  ];
  const worktrees: WorktreeItem[] = [];
  for (const entry of entries) {
    let record = snapshot.value.worktrees.find((record) => record.path === entry.path) ?? null;
    if (entry.path !== snapshot.value.project.path && record === null) {
      const name = basename(entry.path);
      if (name.startsWith("issue-") || name.startsWith("design-")) continue;
      const discovered = deps.repository.discover({
        id: deps.id(),
        projectId,
        path: entry.path,
        branch: entry.branch ?? "",
        branchCreated: false,
        origin: "user",
        issueId: null,
      });
      if (discovered.isErr()) return err(discovered.error);
      record = discovered.value;
    }
    const described = await describeWorktree(snapshot.value, entry, record, deps);
    if (described.isErr()) return err(described.error);
    worktrees.push(described.value.item);
  }
  return ok({ worktrees });
}
