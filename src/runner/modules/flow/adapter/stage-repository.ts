import { asc, eq, isNull, sql } from "drizzle-orm";
import type { WorktreeActivityReservation } from "../../../../shared/workspace/worktree-activity";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { issues, issueEvents, projects, settings } from "../../../../shared/db/schema";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import { createIssueDataRepository } from "../../../../server/modules/issue/adapter/issue-repository";
import { createIssueRepository } from "./issue-repository";

import type { StageRepository } from "../domain/stage-ports";

export function createStageRepository(
  database: OpenedDatabase,
  now: () => number,
): StageRepository {
  const { db } = database;
  const activity = createWorktreeActivity(database.sqlite.name);
  const data = createIssueDataRepository(db);
  const project = (id: string) => db.select().from(projects).where(eq(projects.id, id)).get();
  const globallyPaused = () =>
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, "flow_paused")).get()
      ?.value === true;
  const events = (id: string) =>
    db
      .select()
      .from(issueEvents)
      .where(eq(issueEvents.issueId, id))
      .orderBy(asc(issueEvents.seq))
      .all();
  const read = (id: string) =>
    activity.run((reservation) => {
      const repo = createIssueRepository(db, reservation);
      const issue = data.get(id);
      const settings = issue && project(issue.projectId);
      if (!issue || !settings) return;
      return { issue, project: settings, events: events(id), context: repo.contextOf(issue) };
    });
  const transaction = <T>(
    action: (
      flow: ReturnType<typeof createIssueRepository>,
      data: ReturnType<typeof createIssueDataRepository>,
    ) => T,
    lease?: WorktreeActivityReservation,
  ) => {
    const run = (reservation: WorktreeActivityReservation) =>
      db.transaction(
        (tx) => action(createIssueRepository(tx, reservation), createIssueDataRepository(tx)),
        { behavior: "immediate" },
      );
    return lease ? run(lease) : activity.run(run);
  };
  return {
    data,
    now,
    project,
    globallyPaused,
    read,
    events,
    projects: () =>
      db
        .select({ id: projects.id })
        .from(projects)
        .where(isNull(projects.removedAt))
        .orderBy(sql`projects.rowid`)
        .all(),
    issues: (id: string) =>
      db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, id))
        .orderBy(asc(issues.number))
        .all(),
    transaction,
    append: (issueId: string, type: string, payload: unknown) =>
      data.append(issueId, type, payload, now()),
  };
}
