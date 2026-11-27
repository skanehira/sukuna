import { and, desc, eq, isNull } from "drizzle-orm";
import type { OpenedDatabase } from "./open";
import { conversations, issues, projects, issueEvents } from "./schema";
import type { DesignRecord } from "../design/records";

export function readDesignRecord(
  db: Pick<OpenedDatabase["db"], "select">,
  id: string,
): DesignRecord | null {
  const current = db
    .select({ issue: issues, project: projects })
    .from(issues)
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(and(eq(issues.id, id), isNull(projects.removedAt)))
    .get();
  if (!current) return null;
  const conversation =
    db
      .select({
        id: conversations.id,
        cwd: conversations.cwd,
        worktreeId: conversations.worktreeId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.issueId, id),
          eq(conversations.projectId, current.project.id),
          eq(conversations.kind, "design"),
        ),
      )
      .orderBy(desc(conversations.id))
      .limit(1)
      .get() ?? null;
  const events = db
    .select()
    .from(issueEvents)
    .where(eq(issueEvents.issueId, id))
    .orderBy(issueEvents.seq)
    .all();
  return { ...current, conversation, events };
}
