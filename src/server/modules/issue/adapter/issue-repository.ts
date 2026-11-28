import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../../shared/db/schema";
import type { IssueDataRepository, IssueDataUnitOfWork } from "../../../../shared/issue/ports";
import {
  issueViewSchema,
  type IssueReference,
  type IssueView,
} from "../../../../shared/issue/schema";
import { z } from "zod";
import { stateChangedSchema } from "../../../../shared/issue/state";

type Database = BetterSQLite3Database<typeof schema>;
export type IssueQueryDatabase = Pick<Database, "select" | "insert" | "update" | "delete">;
const { issues, issueDependencies, issueEvents, projects, conversations, worktrees } = schema;
const reference = ({ id, number, title, state }: IssueReference): IssueReference => ({
  id,
  number,
  title,
  state,
});

export function createIssueDataUnitOfWork(db: Database): IssueDataUnitOfWork {
  const run = <T>(action: (repository: IssueDataRepository) => T) =>
    db.transaction((tx) => action(createIssueDataRepository(tx)), { behavior: "immediate" });
  return {
    read: createIssueDataRepository(db),
    run,
    create: (action) => {
      try {
        return run(action);
      } catch (error) {
        if (!isIssueNumberConflict(error)) throw error;
        return run(action);
      }
    },
  };
}
function isIssueNumberConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "UNIQUE constraint failed: issues.project_id, issues.number") return true;
  return isIssueNumberConflict(error.cause);
}
export function createIssueDataRepository(db: IssueQueryDatabase): IssueDataRepository {
  const all = (projectId: string) =>
    db
      .select()
      .from(issues)
      .where(eq(issues.projectId, projectId))
      .orderBy(asc(issues.number))
      .all();
  const get = (id: string) => db.select().from(issues).where(eq(issues.id, id)).get();
  const project = (id: string) =>
    db
      .select({ id: projects.id, confirmBeforeMergeDefault: projects.confirmBeforeMergeDefault })
      .from(projects)
      .where(and(eq(projects.id, id), isNull(projects.removedAt)))
      .get();
  const events = (id: string) =>
    db
      .select()
      .from(issueEvents)
      .where(eq(issueEvents.issueId, id))
      .orderBy(desc(issueEvents.seq))
      .all();
  const designPrPending = (id: string) => {
    const history = events(id);
    const latest = (type: string) => history.find((event) => event.type === type)?.seq ?? 0;
    return (
      latest("design_pr_created") >
        Math.max(latest("design_reflected"), latest("design_rejected")) &&
      latest("design_pr_created") > latest("design_approved") &&
      latest("design_approved") > 0
    );
  };
  const view = (id: string, includePageDetails = false): IssueView | undefined => {
    const issue = get(id);
    if (!issue || !project(issue.projectId)) return undefined;
    const siblings = all(issue.projectId);
    const edges = db.select().from(issueDependencies).all();
    const history = events(id);
    const created =
      issue.createdConversationId === null
        ? undefined
        : db
            .select()
            .from(conversations)
            .where(eq(conversations.id, issue.createdConversationId))
            .get();
    const stopped = z
      .object({ to: z.string(), detail: z.string().nullable() })
      .safeParse(history.find((event) => event.type === "state_changed")?.payload);
    const pageDetails: Pick<IssueView, "stoppedFrom" | "stopCause" | "keptWorktreePath"> = {};
    if (includePageDetails && issue.state === "stopped") {
      const stops = history.flatMap((event) => {
        if (event.type !== "state_changed") return [];
        const result = stateChangedSchema.safeParse(event.payload);
        return result.success && result.data.to === "stopped" ? [result.data] : [];
      });
      pageDetails.stoppedFrom =
        stops.find(({ from }) => from !== null && from !== "stopped")?.from ?? undefined;
      pageDetails.stopCause = stops[0]?.cause;
    }
    if (includePageDetails && (issue.state === "done" || issue.state === "withdrawn")) {
      const keptIds = history.flatMap((event) => {
        if (event.type !== "worktree_kept") return [];
        const result = z.object({ worktreeId: z.string() }).safeParse(event.payload);
        return result.success ? [result.data.worktreeId] : [];
      });
      if (keptIds.length > 0) {
        const kept = db
          .select({ id: worktrees.id, path: worktrees.path })
          .from(worktrees)
          .where(
            and(
              eq(worktrees.projectId, issue.projectId),
              isNull(worktrees.removedAt),
              inArray(worktrees.id, keptIds),
            ),
          )
          .all();
        const paths = new Map(kept.map(({ id: worktreeId, path }) => [worktreeId, path]));
        pageDetails.keptWorktreePath = keptIds
          .map((worktreeId) => paths.get(worktreeId))
          .find((path) => path !== undefined);
      }
    }
    const { parentId, ...fields } = issue;
    return {
      ...fields,
      ...pageDetails,
      stopDetail: issue.state === "stopped" && stopped.success ? stopped.data.detail : null,
      createdConversation:
        issue.createdConversationId === null
          ? null
          : {
              id: issue.createdConversationId,
              title: created?.title ?? null,
              deleted: created === undefined,
            },
      parent: siblings.find((row) => row.id === parentId)
        ? reference(siblings.find((row) => row.id === parentId)!)
        : null,
      children: siblings.filter((row) => row.parentId === id).map(reference),
      dependsOn: siblings
        .filter((row) => edges.some((edge) => edge.issueId === id && edge.dependsOnId === row.id))
        .map(reference),
      dependents: siblings
        .filter((row) => edges.some((edge) => edge.issueId === row.id && edge.dependsOnId === id))
        .map(reference),
      conversations: db
        .select({
          id: conversations.id,
          kind: conversations.kind,
          runState: conversations.runState,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.issueId, id),
            inArray(conversations.kind, ["triage", "design", "impl"]),
          ),
        )
        .orderBy(asc(conversations.id))
        .all()
        .map((row) => issueViewSchema.shape.conversations.element.parse(row)),
      comments: history
        .filter((event) => event.type === "comment")
        .slice(0, 50)
        .reverse()
        .map((event) => ({
          at: event.createdAt,
          ...z.object({ conversationId: z.string(), text: z.string() }).parse(event.payload),
        })),
    };
  };
  return {
    project,
    get,
    all,
    view,
    designPrPending,
    byNumber: (projectId, number) =>
      db
        .select()
        .from(issues)
        .where(and(eq(issues.projectId, projectId), eq(issues.number, number)))
        .get(),
    nextNumber: (projectId) =>
      (db
        .select({ number: max(issues.number) })
        .from(issues)
        .where(eq(issues.projectId, projectId))
        .get()?.number ?? 0) + 1,
    graph: (projectId) => {
      const rows = all(projectId);
      const edges = db.select().from(issueDependencies).all();
      return rows.map((issue) => ({
        number: issue.number,
        parentNumber: rows.find((row) => row.id === issue.parentId)?.number ?? null,
        dependsOn: rows
          .filter((row) =>
            edges.some((edge) => edge.issueId === issue.id && edge.dependsOnId === row.id),
          )
          .map((row) => row.number),
      }));
    },
    list: (projectId, input) => {
      const matched = all(projectId)
        .filter(
          (issue) =>
            (!input.state || input.state.includes(issue.state)) &&
            (input.q === undefined ||
              issue.title.includes(input.q) ||
              issue.body.includes(input.q)) &&
            (input.cursor === undefined || issue.number < input.cursor),
        )
        .reverse();
      const items = matched.slice(0, input.limit).map((row) => {
        const {
          body: _body,
          children: _children,
          dependents: _dependents,
          conversations: _conversations,
          comments: _comments,
          ...summary
        } = view(row.id)!;
        return summary;
      });
      return {
        items,
        nextCursor: matched.length > input.limit ? String(items.at(-1)!.number) : null,
      };
    },
    insert: (issue, dependencies) => {
      db.insert(issues).values(issue).run();
      if (dependencies.length)
        db.insert(issueDependencies)
          .values(dependencies.map((dependsOnId) => ({ issueId: issue.id, dependsOnId })))
          .run();
    },
    update: (id, fields, dependencies) => {
      db.update(issues).set(fields).where(eq(issues.id, id)).run();
      if (dependencies !== undefined) {
        db.delete(issueDependencies).where(eq(issueDependencies.issueId, id)).run();
        if (dependencies.length)
          db.insert(issueDependencies)
            .values(dependencies.map((dependsOnId) => ({ issueId: id, dependsOnId })))
            .run();
      }
    },
    append: (id, type, payload, now) => {
      const seq =
        (db
          .select({ seq: max(issueEvents.seq) })
          .from(issueEvents)
          .where(eq(issueEvents.issueId, id))
          .get()?.seq ?? 0) + 1;
      const event = { issueId: id, seq, type, payload, createdAt: now };
      db.insert(issueEvents).values(event).run();
      return event;
    },
    conversation: (id) =>
      db
        .select({
          id: conversations.id,
          projectId: conversations.projectId,
          issueId: conversations.issueId,
          kind: conversations.kind,
        })
        .from(conversations)
        .where(eq(conversations.id, id))
        .get(),
    activeConversationIds: (issueId) =>
      db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.issueId, issueId),
            inArray(conversations.kind, ["triage", "design", "impl"]),
            inArray(conversations.runState, ["working", "waiting_answer", "waiting_permission"]),
          ),
        )
        .all()
        .map((row) => row.id),
  };
}
