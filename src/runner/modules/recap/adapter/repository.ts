import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  conversations,
  conversationEvents,
  projects,
  questions,
  tocEntries,
} from "../../../../shared/db/schema";
import type { RecapRepository } from "../domain/repository";

export function createRunnerRecapRepository(db: OpenedDatabase["db"]): RecapRepository {
  return {
    get: (id) =>
      db
        .select({
          id: conversations.id,
          path: projects.path,
          cwd: conversations.cwd,
          title: sql<string>`coalesce(${conversations.title}, '')`,
          reflectedSeq: conversations.recapSeq,
          failedAt: conversations.recapFailedAt,
        })
        .from(conversations)
        .innerJoin(projects, eq(conversations.projectId, projects.id))
        .where(eq(conversations.id, id))
        .get(),
    projectPath: (id) =>
      db.select({ path: projects.path }).from(projects).where(eq(projects.id, id)).get()?.path,
    lastTurn: (id) =>
      db
        .select({ seq: conversationEvents.seq, createdAt: conversationEvents.createdAt })
        .from(conversationEvents)
        .where(
          and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, "turn_end")),
        )
        .orderBy(desc(conversationEvents.seq))
        .get(),
    unfinished: () =>
      db.all<{ id: string; endSeq: number }>(sql`
      SELECT c.id, e.seq AS endSeq
      FROM ${conversations} c
      JOIN ${projects} p ON p.id = c.project_id
      JOIN ${conversationEvents} e ON e.conversation_id = c.id AND e.seq = (
        SELECT max(seq) FROM ${conversationEvents} WHERE conversation_id = c.id AND type = 'turn_end'
      )
      WHERE c.recap_seq < e.seq AND (c.recap_failed_at IS NULL OR c.recap_failed_at < e.created_at)
    `),
    nextTurn: (id, after) => {
      const remaining = and(
        eq(conversationEvents.conversationId, id),
        gt(conversationEvents.seq, after),
      );
      const end = db
        .select({ seq: conversationEvents.seq })
        .from(conversationEvents)
        .where(and(remaining, eq(conversationEvents.type, "turn_end")))
        .orderBy(asc(conversationEvents.seq))
        .get();
      if (!end) return undefined;
      const events = db
        .select({
          seq: conversationEvents.seq,
          type: conversationEvents.type,
          payload: conversationEvents.payload,
          createdAt: conversationEvents.createdAt,
        })
        .from(conversationEvents)
        .where(and(remaining, lte(conversationEvents.seq, end.seq)))
        .orderBy(asc(conversationEvents.seq))
        .all();
      return { startSeq: events[0]?.seq ?? end.seq, endSeq: end.seq, events };
    },
    chapters: (id) =>
      db
        .select({
          position: tocEntries.position,
          title: tocEntries.title,
          startSeq: tocEntries.startSeq,
        })
        .from(tocEntries)
        .where(eq(tocEntries.conversationId, id))
        .orderBy(asc(tocEntries.position))
        .all(),
    questions: (id) =>
      db
        .select({ id: questions.id, text: questions.text })
        .from(questions)
        .where(
          and(
            eq(questions.conversationId, id),
            eq(questions.kind, "text"),
            eq(questions.answered, false),
          ),
        )
        .orderBy(asc(questions.seq), sql`${questions}.rowid`)
        .all(),
    fail: (id, reflectedSeq, time) =>
      db
        .update(conversations)
        .set({ recapFailedAt: time })
        .where(and(eq(conversations.id, id), eq(conversations.recapSeq, reflectedSeq)))
        .run().changes === 1,
    save: (id, reflectedSeq, turn, summary) => {
      db.transaction(
        (tx) => {
          const advanced = tx
            .update(conversations)
            .set({ recapSeq: turn.endSeq, recapFailedAt: null })
            .where(and(eq(conversations.id, id), eq(conversations.recapSeq, reflectedSeq)))
            .run();
          if (advanced.changes !== 1) throw new Error("会話の反映位置が変わりました。");
          const last = tx
            .select()
            .from(tocEntries)
            .where(eq(tocEntries.conversationId, id))
            .orderBy(desc(tocEntries.position))
            .get();
          if (summary.title !== null && (!last || turn.startSeq > last.startSeq)) {
            tx.insert(tocEntries)
              .values({
                conversationId: id,
                position: (last?.position ?? 0) + 1,
                title: summary.title,
                startSeq: turn.startSeq,
              })
              .run();
          }
          for (const question of summary.questions)
            tx.insert(questions)
              .values({ ...question, conversationId: id, kind: "text" })
              .run();
          if (summary.answered.length) {
            tx.update(questions)
              .set({ answered: true })
              .where(
                and(
                  eq(questions.conversationId, id),
                  eq(questions.kind, "text"),
                  inArray(questions.id, summary.answered),
                ),
              )
              .run();
          }
        },
        { behavior: "immediate" },
      );
    },
  };
}
