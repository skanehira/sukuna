import { err, ok, type Result } from "neverthrow";
import type { ListedConversation, ProjectConversations } from "../../../../shared/lifecycle";
import type { ConversationRecord, LifecycleError, LifecycleRepository } from "../domain/lifecycle";

export function listConversations(
  id: string,
  repository: LifecycleRepository,
): Result<ProjectConversations, LifecycleError> {
  const data = repository.project(id);
  if (!data)
    return err({
      code: "not_found",
      message: "プロジェクトが見つかりません。読み直してください。",
    });
  const rows = new Map(data.conversations.map((row) => [row.id, row]));
  const threads = new Map<string, ListedConversation[]>();
  const issueThreads = new Map<string, ListedConversation[]>();
  for (const thread of data.conversations) {
    if (thread.kind !== "thread" || thread.parentId === null) continue;
    const parent = rows.get(thread.parentId);
    if (!parent) continue;
    if (parent.kind === "chat") addThread(threads, parent.id, thread);
    else if (parent.issueId !== null) addThread(issueThreads, parent.issueId, thread);
  }
  return ok({
    conversations: data.conversations
      .filter((row) => row.kind === "chat")
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id.localeCompare(a.id))
      .map((row) => ({ ...listed(row), threads: threads.get(row.id) ?? [] })),
    issueThreads: data.issues.flatMap(({ id, title, number }) => {
      const threads = issueThreads.get(id);
      return threads ? [{ issue: { id, number, title }, threads }] : [];
    }),
  });
}

function listed({
  id,
  title,
  runState,
  closedAt,
  lastActivityAt,
}: ConversationRecord): ListedConversation {
  return { id, title, runState, closedAt, lastActivityAt };
}

function addThread(
  groups: Map<string, ListedConversation[]>,
  id: string,
  thread: ConversationRecord,
) {
  const group = groups.get(id);
  if (group) group.push(listed(thread));
  else groups.set(id, [listed(thread)]);
}
