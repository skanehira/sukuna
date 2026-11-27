import type Database from "better-sqlite3";
import type { PublicConversation } from "./api";

export function readPublicConversation(
  sqlite: Database.Database,
  id: string,
): PublicConversation | null {
  const row = sqlite
    .prepare(
      "SELECT c.id,c.project_id AS projectId,COALESCE(p.name,'') AS projectName,c.kind,c.issue_id AS issueId,c.parent_conversation_id AS parentConversationId,COALESCE(c.title,'新しい会話') AS title,c.cwd,c.worktree_id AS worktreeId,w.path AS worktreePath,w.branch AS worktreeBranch,c.run_state AS runState,c.stop_reason AS stopReason,c.resets_at AS resetsAt,c.last_seq AS lastSeq,c.last_read_seq AS lastReadSeq,c.last_position AS lastPosition,c.closed_at AS closedAt FROM conversations c LEFT JOIN projects p ON p.id=c.project_id LEFT JOIN worktrees w ON w.id=c.worktree_id WHERE c.id=?",
    )
    .get(id) as
    | (Omit<PublicConversation, "worktree"> & {
        worktreeId: string | null;
        worktreePath: string | null;
        worktreeBranch: string | null;
      })
    | undefined;
  if (!row) return null;
  const { worktreeId, worktreePath, worktreeBranch, ...conversation } = row;
  return {
    ...conversation,
    worktree:
      worktreeId && worktreePath && worktreeBranch
        ? { id: worktreeId, name: worktreePath.split("/").at(-1)!, branch: worktreeBranch }
        : null,
  };
}
