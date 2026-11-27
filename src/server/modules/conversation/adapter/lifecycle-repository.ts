import { z } from "zod";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  conversations,
  conversationEvents,
  issues,
  notifications,
  projects,
  settings,
  stockItems,
} from "../../../../shared/db/schema";
import { releaseReservationKey, retiredUsageTimerKey } from "../../../../shared/ipc";
import type { SearchResult } from "../../../../shared/lifecycle";
import type { ConversationRecord, LifecycleRepository } from "../domain/lifecycle";

const pendingWithdrawalKey = (id: string) => `conversation-close-withdraw:${id}`;
const withdrawalSchema = z.object({ closedAt: z.number(), notificationIds: z.array(z.string()) });
const conversationFields = {
  id: conversations.id,
  projectId: conversations.projectId,
  kind: conversations.kind,
  issueId: conversations.issueId,
  parentId: conversations.parentConversationId,
  title: conversations.title,
  cwd: conversations.cwd,
  runState: conversations.runState,
  lastActivityAt: conversations.lastActivityAt,
  closedAt: conversations.closedAt,
};
const issueFields = {
  id: issues.id,
  number: issues.number,
  title: issues.title,
  state: issues.state,
};
type NullableRecord = Omit<ConversationRecord, "title" | "lastActivityAt"> & {
  title: string | null;
  lastActivityAt: number | null;
};

function conversationRow(row: NullableRecord): ConversationRecord {
  return { ...row, title: row.title ?? "", lastActivityAt: row.lastActivityAt ?? 0 };
}

export function createLifecycleRepository(database: () => OpenedDatabase): LifecycleRepository {
  const conversation = (id: string) => {
    const row = database()
      .db.select(conversationFields)
      .from(conversations)
      .where(eq(conversations.id, id))
      .get();
    return row && conversationRow(row);
  };
  const transaction = <T>(run: () => T) => database().sqlite.transaction(run).immediate();
  return {
    conversation,
    threads(id) {
      return database()
        .db.select(conversationFields)
        .from(conversations)
        .where(and(eq(conversations.parentConversationId, id), eq(conversations.kind, "thread")))
        .orderBy(asc(conversations.id))
        .all()
        .map(conversationRow);
    },
    summary(id) {
      const current = conversation(id);
      if (!current) return;
      const { db } = database();
      const project = db
        .select({ usesGithub: projects.usesGithub, defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(eq(projects.id, current.projectId))
        .get();
      if (!project) return;
      const firstEventAt =
        db
          .select({ createdAt: conversationEvents.createdAt })
          .from(conversationEvents)
          .where(eq(conversationEvents.conversationId, id))
          .orderBy(asc(conversationEvents.seq))
          .get()?.createdAt ?? null;
      const createdIssues = db
        .select(issueFields)
        .from(issues)
        .where(eq(issues.createdConversationId, id))
        .orderBy(asc(issues.number))
        .all();
      const stocked = db
        .select({ kind: stockItems.kind })
        .from(stockItems)
        .where(and(eq(stockItems.conversationId, id), eq(stockItems.state, "stocked")))
        .all();
      const questions = stocked.filter(({ kind }) => kind === "question").length;
      return {
        conversation: current,
        firstEventAt,
        createdIssues,
        project,
        stock: { questions, instructions: stocked.length - questions },
      };
    },
    project(id) {
      const { db } = database();
      if (
        !db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, id), isNull(projects.removedAt)))
          .get()
      )
        return;
      return {
        conversations: db
          .select(conversationFields)
          .from(conversations)
          .where(eq(conversations.projectId, id))
          .orderBy(asc(conversations.id))
          .all()
          .map(conversationRow),
        issues: db.select(issueFields).from(issues).where(eq(issues.projectId, id)).all(),
      };
    },
    search(query, limit) {
      return search(database().sqlite, query, limit);
    },
    transaction,
    activeReservations(reservations) {
      const reservation = database().sqlite.prepare(`
        SELECT 1 FROM settings
        WHERE key=? AND json_extract(value,'$.token')=?
          AND json_extract(value,'$.expiresAt') > unixepoch('subsec') * 1000
      `);
      return reservations.every(({ id, token }) =>
        Boolean(reservation.get(releaseReservationKey(id), token)),
      );
    },
    close(id, at, conversationIds) {
      const { db } = database();
      db.update(conversations).set({ closedAt: at }).where(eq(conversations.id, id)).run();
      const usageLimited = db
        .select({ id: conversations.id, seq: conversations.lastSeq })
        .from(conversations)
        .where(
          and(
            inArray(conversations.id, conversationIds),
            eq(conversations.runState, "usage_limited"),
          ),
        )
        .all();
      for (const { id, seq } of usageLimited)
        db.insert(settings)
          .values({ key: retiredUsageTimerKey(id), value: seq })
          .onConflictDoUpdate({ target: settings.key, set: { value: seq } })
          .run();
      const notificationIds = db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.targetKind, "conversation"),
            inArray(notifications.targetId, conversationIds),
            isNull(notifications.dismissedAt),
          ),
        )
        .orderBy(asc(notifications.id))
        .all()
        .map(({ id }) => id);
      const value = { closedAt: at, notificationIds };
      db.insert(settings)
        .values({ key: pendingWithdrawalKey(id), value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
    },
    pendingWithdrawal(id, at) {
      const row = database()
        .db.select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, pendingWithdrawalKey(id)))
        .get();
      const parsed = withdrawalSchema.safeParse(row?.value);
      if (parsed.success && parsed.data.closedAt === at) return parsed.data.notificationIds;
    },
    completeWithdrawal(id, at) {
      database()
        .sqlite.prepare("DELETE FROM settings WHERE key=? AND json_extract(value,'$.closedAt')=?")
        .run(pendingWithdrawalKey(id), at);
    },
    delete(ids) {
      const { db } = database();
      db.update(stockItems)
        .set({ threadConversationId: null })
        .where(inArray(stockItems.threadConversationId, ids))
        .run();
      db.delete(notifications)
        .where(
          and(eq(notifications.targetKind, "conversation"), inArray(notifications.targetId, ids)),
        )
        .run();
      db.delete(conversations).where(inArray(conversations.id, ids)).run();
      db.delete(settings)
        .where(
          inArray(
            settings.key,
            ids.flatMap((id) => [pendingWithdrawalKey(id), retiredUsageTimerKey(id)]),
          ),
        )
        .run();
    },
  };
}

type SqlSearchRow = {
  id: string;
  projectId: string;
  title: string;
  lastActivityAt: number;
} & (
  | { type: "issue"; number: number; state: Extract<SearchResult, { type: "issue" }>["state"] }
  | {
      type: "conversation";
      kind: "chat" | "thread";
      parentId: string | null;
      runState: ConversationRecord["runState"];
      closedAt: number | null;
    }
);

function search(sqlite: OpenedDatabase["sqlite"], query: string, limit: number): SearchResult[] {
  const words = query.trim().split(/\s+/);
  const patterns = words.map((word) => `%${word.replace(/[\\%_]/g, "\\$&")}%`);
  const issueParameters: (string | number)[] = [];
  const issueTerms = words.map((word, index) => {
    const pattern = patterns[index]!;
    issueParameters.push(pattern, pattern);
    const text = "i.title LIKE ? ESCAPE char(92) OR i.body LIKE ? ESCAPE char(92)";
    const number = /^#?\d+$/.test(word) ? Number(word.replace(/^#/, "")) : NaN;
    if (!Number.isSafeInteger(number)) return `(${text})`;
    issueParameters.push(number);
    return `(${text} OR i.number=?)`;
  });
  const conversationTerms = words.map(() => "c.title LIKE ? ESCAPE char(92)");
  const rows = sqlite
    .prepare(`
    SELECT * FROM (
    SELECT 'issue' AS type, i.id AS id, i.project_id AS projectId, i.title, i.updated_at AS lastActivityAt,
      i.number, i.state, NULL AS kind, NULL AS parentId, NULL AS runState, NULL AS closedAt
    FROM issues i INNER JOIN projects p ON p.id=i.project_id AND p.removed_at IS NULL
    WHERE ${issueTerms.join(" AND ")}
    UNION ALL
    SELECT 'conversation', c.id, c.project_id, COALESCE(c.title,''), COALESCE(c.last_activity_at,0),
      NULL, NULL, c.kind, c.parent_conversation_id, c.run_state, c.closed_at
    FROM conversations c INNER JOIN projects p ON p.id=c.project_id AND p.removed_at IS NULL
    WHERE (c.kind='chat' OR (c.kind='thread' AND EXISTS (
      SELECT 1 FROM conversations parent
      WHERE parent.id=c.parent_conversation_id AND parent.project_id=c.project_id
    ))) AND ${conversationTerms.join(" AND ")}
    )
    ORDER BY lastActivityAt DESC, id DESC, type
    LIMIT ?
  `)
    .all(...issueParameters, ...patterns, limit) as SqlSearchRow[];
  return rows.map((row) => {
    const common = {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      lastActivityAt: row.lastActivityAt,
    };
    if (row.type === "issue")
      return { ...common, type: "issue", number: row.number, state: row.state };
    const conversation = {
      ...common,
      type: "conversation" as const,
      closedAt: row.closedAt,
      runState: row.runState,
    };
    return row.kind === "thread" && row.parentId !== null
      ? { ...conversation, kind: "thread", parentId: row.parentId }
      : { ...conversation, kind: "chat" };
  });
}
