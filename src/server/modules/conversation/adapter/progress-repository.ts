import { asc, desc, eq } from "drizzle-orm";
import { Result } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  conversations,
  conversationEvents,
  issues,
  issueEvents,
} from "../../../../shared/db/schema";
import type { ProgressError, ProgressRepositoryPort } from "../domain/progress-port";

export function createProgressRepository(db: OpenedDatabase["db"]): ProgressRepositoryPort {
  const failure = (): ProgressError => ({
    code: "internal",
    message: "作業の状況を取得できませんでした。もう一度開いてください。",
  });
  return {
    findConversation: (id) =>
      Result.fromThrowable(
        () => db.select().from(conversations).where(eq(conversations.id, id)).get() ?? null,
        failure,
      )(),
    findIssue: (id) =>
      Result.fromThrowable(
        () => db.select().from(issues).where(eq(issues.id, id)).get() ?? null,
        failure,
      )(),
    listIssueConversations: (issueId) =>
      Result.fromThrowable(
        () =>
          db
            .select()
            .from(conversations)
            .where(eq(conversations.issueId, issueId))
            .orderBy(desc(conversations.id))
            .all(),
        failure,
      )(),
    conversationEvents: (id) =>
      Result.fromThrowable(
        () =>
          db
            .select()
            .from(conversationEvents)
            .where(eq(conversationEvents.conversationId, id))
            .orderBy(asc(conversationEvents.seq))
            .all(),
        failure,
      )(),
    issueEvents: (id) =>
      Result.fromThrowable(
        () =>
          db
            .select()
            .from(issueEvents)
            .where(eq(issueEvents.issueId, id))
            .orderBy(asc(issueEvents.seq))
            .all(),
        failure,
      )(),
  };
}
