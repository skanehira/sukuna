import { and, eq, isNull } from "drizzle-orm";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { worktrees } from "../../../../shared/db/schema";
import type { TerminalCleanupRequest } from "../../../../shared/ipc";
import type { PtySessions } from "./pty-session";

export function prepareWorktreeTerminalCleanup(
  db: OpenedDatabase["db"],
  terminals: Pick<PtySessions, "prepareCleanup">,
  request: TerminalCleanupRequest,
) {
  const row = db
    .select({ path: worktrees.path })
    .from(worktrees)
    .where(
      and(
        eq(worktrees.id, request.worktree_id),
        eq(worktrees.origin, "flow"),
        isNull(worktrees.removedAt),
      ),
    )
    .get();
  if (!row || row.path !== request.path) return;
  return terminals.prepareCleanup(request.worktree_id, request.path, request.directory_key);
}
