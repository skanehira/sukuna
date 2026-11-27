import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ok } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  projects,
  conversations,
  conversationEvents,
  questions,
  issues,
  issueEvents,
  issueDependencies,
  settings,
  worktrees,
} from "../../../../shared/db/schema";
import type { InboxRepositoryPort } from "../domain/ports";
export function createInboxRepository(database: () => OpenedDatabase["db"]): InboxRepositoryPort {
  return {
    load() {
      const db = database();
      return ok({
        flowPaused:
          db.select().from(settings).where(eq(settings.key, "flow_paused")).get()?.value === true,
        projects: db
          .select()
          .from(projects)
          .where(isNull(projects.removedAt))
          .orderBy(sql`projects.rowid`)
          .all()
          .map((project) => ({
            ...project,
            conversations: db
              .select()
              .from(conversations)
              .where(eq(conversations.projectId, project.id))
              .orderBy(sql`conversations.rowid`)
              .all()
              .map((conversation) => ({
                ...conversation,
                events: db
                  .select()
                  .from(conversationEvents)
                  .where(eq(conversationEvents.conversationId, conversation.id))
                  .orderBy(asc(conversationEvents.seq))
                  .all(),
                questions: db
                  .select()
                  .from(questions)
                  .where(
                    and(
                      eq(questions.conversationId, conversation.id),
                      eq(questions.answered, false),
                    ),
                  )
                  .orderBy(asc(questions.seq), asc(questions.id))
                  .all()
                  .map((q) => q.text),
              })),
            issues: db
              .select()
              .from(issues)
              .where(eq(issues.projectId, project.id))
              .all()
              .map((issue) => ({
                ...issue,
                events: db
                  .select()
                  .from(issueEvents)
                  .where(eq(issueEvents.issueId, issue.id))
                  .orderBy(asc(issueEvents.seq))
                  .all(),
              })),
            dependencies: db
              .select({
                issueId: issueDependencies.issueId,
                dependsOnId: issueDependencies.dependsOnId,
              })
              .from(issueDependencies)
              .innerJoin(issues, eq(issues.id, issueDependencies.issueId))
              .where(eq(issues.projectId, project.id))
              .all(),
            worktrees: db.select().from(worktrees).where(eq(worktrees.projectId, project.id)).all(),
          })),
      });
    },
  };
}
export function formatResetTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
