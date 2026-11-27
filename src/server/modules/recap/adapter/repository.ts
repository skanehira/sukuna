import { and, asc, eq, sql } from "drizzle-orm";
import { Result } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  conversations,
  conversationEvents,
  drafts,
  projects,
  questions,
  queuedInstructions,
  stockItems,
  tocEntries,
} from "../../../../shared/db/schema";
import { eventSchema } from "../../../../shared/events";
import type { RecapError, RecapRepository } from "../domain/ports";
import type { RecapResponse } from "../../../../shared/recap/api";

type Database = Pick<OpenedDatabase["db"], "select" | "update" | "transaction">;
const internal = (): RecapError => ({
  code: "internal",
  message: "会話の状況を読み書きできませんでした。もう一度操作してください。",
});
export function createRecapRepository(database: () => Database): RecapRepository {
  const repository: RecapRepository = {
    context: (id) =>
      Result.fromThrowable(
        () =>
          database().transaction((db) => {
            const conversation = db
              .select()
              .from(conversations)
              .where(eq(conversations.id, id))
              .get();
            if (!conversation) return undefined;
            const project = db
              .select({ path: projects.path })
              .from(projects)
              .where(eq(projects.id, conversation.projectId))
              .get();
            if (!project) throw new Error("プロジェクトがありません");
            const records = db
              .select()
              .from(conversationEvents)
              .where(eq(conversationEvents.conversationId, id))
              .orderBy(asc(conversationEvents.seq))
              .all();
            const lastTurn = records.findLast((record) => record.type === "turn_end");
            const lastUser = records
              .filter((record) => record.type === "user_message")
              .map((record) => ({
                ...record,
                event: eventSchema.parse({ type: record.type, payload: record.payload }),
              }))
              .findLast(
                (record) =>
                  record.event.type === "user_message" &&
                  record.event.payload.origin !== "flow" &&
                  record.event.payload.origin !== "resume",
              );
            const draft = db.select().from(drafts).where(eq(drafts.conversationId, id)).get();
            const stocks = db
              .select({ state: stockItems.state })
              .from(stockItems)
              .where(eq(stockItems.conversationId, id))
              .all();
            const threads = db
              .select({ runState: conversations.runState, closedAt: conversations.closedAt })
              .from(conversations)
              .where(
                and(eq(conversations.parentConversationId, id), eq(conversations.kind, "thread")),
              )
              .all();
            const queue = db
              .select({ id: queuedInstructions.id })
              .from(queuedInstructions)
              .where(eq(queuedInstructions.conversationId, id))
              .all();
            let pendingPermission: RecapResponse["pendingPermission"] = null;
            if (conversation.runState === "waiting_permission") {
              const request = records.findLast((record) => record.type === "permission_request");
              if (request) {
                const parsed = eventSchema.parse({ type: request.type, payload: request.payload });
                if (
                  parsed.type === "permission_request" &&
                  !records.some(
                    (record) =>
                      record.seq > request.seq &&
                      record.type === "permission_decision" &&
                      (record.payload as { request_id: string }).request_id ===
                        parsed.payload.request_id,
                  )
                )
                  pendingPermission = {
                    requestId: parsed.payload.request_id,
                    seq: request.seq,
                    toolName: parsed.payload.tool_name,
                    summary:
                      parsed.payload.title ??
                      parsed.payload.blocked_path ??
                      JSON.stringify(parsed.payload.input),
                  };
              }
            }
            return {
              projectPath: project.path,
              title: conversation.title ?? "",
              lastTurnSeq: lastTurn?.seq ?? 0,
              recap: {
                lastUserMessage:
                  lastUser?.event.type === "user_message"
                    ? { seq: lastUser.seq, text: lastUser.event.payload.text }
                    : null,
                questions: db
                  .select({
                    id: questions.id,
                    seq: questions.seq,
                    kind: questions.kind,
                    text: questions.text,
                  })
                  .from(questions)
                  .where(and(eq(questions.conversationId, id), eq(questions.answered, false)))
                  .orderBy(asc(questions.seq), sql`${questions}.rowid`)
                  .all(),
                pendingPermission,
                draft: {
                  exists: draft !== undefined && (draft.text.length > 0 || draft.images.length > 0),
                },
                counts: {
                  stock: stocks.filter((stock) => stock.state === "stocked").length,
                  threads: threads.length,
                  activeThreads: threads.filter(
                    (thread) => thread.closedAt === null && thread.runState === "working",
                  ).length,
                  queue: queue.length,
                },
                lastReadSeq: conversation.lastReadSeq,
                lastPosition: conversation.lastPosition,
                state: {
                  reflectedSeq: conversation.recapSeq,
                  failedAt: conversation.recapFailedAt,
                  updating:
                    lastTurn !== undefined &&
                    conversation.recapSeq < lastTurn.seq &&
                    (conversation.recapFailedAt === null ||
                      conversation.recapFailedAt < lastTurn.createdAt),
                },
              },
            };
          }),
        internal,
      )(),
    saveRead: (id, input) =>
      Result.fromThrowable(() => {
        const db = database();
        const exists = db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, id))
          .get();
        if (!exists) return false;
        if (input.readSeq === undefined && input.position === undefined) return true;
        return (
          db
            .update(conversations)
            .set({
              ...(input.readSeq === undefined
                ? {}
                : {
                    lastReadSeq: sql`max(${conversations.lastReadSeq}, min(${input.readSeq}, ${conversations.lastSeq}))`,
                  }),
              ...(input.position === undefined ? {} : { lastPosition: input.position }),
            })
            .where(eq(conversations.id, id))
            .run().changes > 0
        );
      }, internal)(),
    chapters: (id) =>
      Result.fromThrowable(
        () =>
          database()
            .select({
              position: tocEntries.position,
              title: tocEntries.title,
              startSeq: tocEntries.startSeq,
            })
            .from(tocEntries)
            .where(eq(tocEntries.conversationId, id))
            .orderBy(asc(tocEntries.position))
            .all(),
        internal,
      )(),
    transaction: (operation) => {
      let failure: RecapError | undefined;
      return Result.fromThrowable(
        () =>
          database().transaction(
            (tx) => {
              const result = operation(createRecapRepository(() => tx));
              if (result.isErr()) {
                failure = result.error;
                throw new Error("目次の変更をロールバックします");
              }
              return result.value;
            },
            { behavior: "immediate" },
          ),
        () => failure ?? internal(),
      )();
    },
    patchChapter: (id, position, patch) =>
      Result.fromThrowable(
        () =>
          database()
            .update(tocEntries)
            .set({
              ...(patch.title === undefined ? {} : { title: patch.title }),
              ...(patch.startSeq === undefined ? {} : { startSeq: patch.startSeq }),
            })
            .where(
              and(
                eq(tocEntries.conversationId, id),
                eq(tocEntries.position, position),
                eq(tocEntries.title, patch.base.title),
                eq(tocEntries.startSeq, patch.base.startSeq),
              ),
            )
            .run().changes > 0,
        internal,
      )(),
  };
  return repository;
}
