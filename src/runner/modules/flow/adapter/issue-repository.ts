import type { OpenedDatabase } from "../../../../shared/db/open";
import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import {
  WorktreeActivityBusy,
  type WorktreeActivityReservation,
} from "../../../../shared/workspace/worktree-activity";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../../shared/db/schema";
import { stateChangedSchema, type StateChanged } from "../../../../shared/issue/state";
import type { FlowIssue, IssueRepositoryPort, IssueUnitOfWorkPort } from "../domain/ports";

type FlowDatabase = BetterSQLite3Database<typeof schema>;
type QueryDatabase = Pick<FlowDatabase, "select" | "insert" | "update">;
const { issues, issueEvents, issueDependencies, conversations } = schema;

export function createIssueUnitOfWork(database: OpenedDatabase): IssueUnitOfWorkPort {
  return {
    run: (action) =>
      createWorktreeActivity(database.directories.state).run((reservation) =>
        database.db.transaction((tx) => action(createIssueRepository(tx, reservation)), {
          behavior: "immediate",
        }),
      ),
  };
}

export function createIssueRepository(
  db: QueryDatabase,
  reservation: WorktreeActivityReservation,
): IssueRepositoryPort {
  const withdrawnDependencies = (id: string) =>
    db
      .select({ number: issues.number })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.dependsOnId))
      .where(and(eq(issueDependencies.issueId, id), eq(issues.state, "withdrawn")))
      .orderBy(asc(issues.number))
      .all();

  return {
    getIssue: (id) =>
      db
        .select({
          id: issues.id,
          projectId: issues.projectId,
          number: issues.number,
          state: issues.state,
          stopReason: issues.stopReason,
          designed: issues.designed,
          confirmBeforeMerge: issues.confirmBeforeMerge,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .get(),

    contextOf: (issue: FlowIssue) => {
      const events = db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, issue.id))
        .orderBy(desc(issueEvents.seq))
        .all();
      const changes = events
        .filter((event) => event.type === "state_changed")
        .map((event) => stateChangedSchema.parse(event.payload));
      const stopped = changes.find(
        (change) => change.to === "stopped" && change.from !== "stopped",
      );
      const children = db
        .select({ state: issues.state })
        .from(issues)
        .where(eq(issues.parentId, issue.id))
        .all();
      const dependencies = db
        .select({ state: issues.state })
        .from(issueDependencies)
        .innerJoin(issues, eq(issues.id, issueDependencies.dependsOnId))
        .where(eq(issueDependencies.issueId, issue.id))
        .all();
      const lastApproval = events.find((event) => event.type === "design_approved")?.seq ?? 0;
      const lastPrCreated = events.find((event) => event.type === "design_pr_created")?.seq ?? 0;
      const lastPrResult =
        events.find(
          (event) => event.type === "design_reflected" || event.type === "design_rejected",
        )?.seq ?? 0;
      return {
        state: issue.state,
        stopReason: issue.stopReason,
        designed: issue.designed,
        confirmBeforeMerge: issue.confirmBeforeMerge,
        stoppedFrom: stopped?.from ?? null,
        stoppedCause: changes.find((change) => change.to === "stopped")?.cause ?? null,
        hasChildren: children.length > 0,
        allChildrenClosed: children.every(
          (child) => child.state === "done" || child.state === "withdrawn",
        ),
        hasDoneChild: children.some((child) => child.state === "done"),
        dependenciesDone: dependencies.every((dependency) => dependency.state === "done"),
        hasWithdrawnDependencies: dependencies.some(
          (dependency) => dependency.state === "withdrawn",
        ),
        designPrMergePending:
          lastPrCreated > lastApproval && lastApproval > 0 && lastPrCreated > lastPrResult,
      };
    },

    saveStateChange: (issue, change: StateChanged, now) => {
      try {
        reservation.acquire(
          db
            .select({ id: schema.worktrees.id })
            .from(schema.worktrees)
            .where(and(eq(schema.worktrees.issueId, issue.id), eq(schema.worktrees.origin, "flow")))
            .all()
            .map((row) => row.id),
        );
      } catch (error) {
        if (error instanceof WorktreeActivityBusy) return null;
        throw error;
      }
      const payload = stateChangedSchema.parse(change);
      const seq =
        (db
          .select({ seq: max(issueEvents.seq) })
          .from(issueEvents)
          .where(eq(issueEvents.issueId, issue.id))
          .get()?.seq ?? 0) + 1;
      db.update(issues)
        .set({
          state: payload.to,
          stopReason: payload.stopReason,
          closedAt: payload.to === "done" || payload.to === "withdrawn" ? now : null,
          updatedAt: now,
          ...(payload.to === "withdrawn" ? { githubNumber: null } : {}),
        })
        .where(eq(issues.id, issue.id))
        .run();
      db.insert(issueEvents)
        .values({ issueId: issue.id, seq, type: "state_changed", payload, createdAt: now })
        .run();
      return { kind: "issue", issue_id: issue.id, project_id: issue.projectId, seq };
    },

    dependentIssueIds: (id) =>
      db
        .select({ id: issues.id })
        .from(issueDependencies)
        .innerJoin(issues, eq(issues.id, issueDependencies.issueId))
        .where(eq(issueDependencies.dependsOnId, id))
        .orderBy(asc(issues.number))
        .all()
        .map((issue) => issue.id),

    withdrawnDependencies,

    workingStageConversationIds: (id) =>
      db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.issueId, id),
            eq(conversations.runState, "working"),
            inArray(conversations.kind, ["triage", "design", "impl"]),
          ),
        )
        .orderBy(asc(conversations.id))
        .all()
        .map((conversation) => conversation.id),
  };
}
