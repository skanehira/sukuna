import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { Result } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { conversations, stockItems } from "../../../../shared/db/schema";
import { releaseReservationKey } from "../../../../shared/ipc";
import { quoteSchema } from "../../../../shared/stock";
import type { StockRecord, StockRepositoryPort } from "../domain/ports";

export function createStockRepository(database: () => OpenedDatabase["db"]): StockRepositoryPort {
  const query = () =>
    database()
      .select({ stock: stockItems, thread: conversations })
      .from(stockItems)
      .leftJoin(conversations, eq(stockItems.threadConversationId, conversations.id));
  type Row = ReturnType<ReturnType<typeof query>["all"]>[number];
  const record = ({ stock, thread }: Row): StockRecord => ({
    id: stock.id,
    conversationId: stock.conversationId,
    kind: stock.kind,
    text: stock.text,
    quote: quoteSchema.parse(JSON.parse(stock.quote ?? "null")),
    state: stock.state,
    sentAt: stock.sentAt,
    sentSeq: stock.sentSeq,
    githubCommentUrl: stock.githubCommentUrl,
    thread:
      thread === null
        ? null
        : {
            id: thread.id,
            title: thread.title,
            runState: thread.runState,
            closed: thread.closedAt !== null,
          },
  });
  const read = (id: string) => {
    const row = query().where(eq(stockItems.id, id)).get();
    return row === undefined ? undefined : record(row);
  };
  const guard = <T>(operation: () => T) =>
    Result.fromThrowable(operation, () => ({
      code: "internal" as const,
      message: "質問・指示を読み書きできませんでした。もう一度操作してください",
    }))();
  return {
    conversation: (id) =>
      guard(() =>
        database()
          .select({
            id: conversations.id,
            kind: conversations.kind,
            parentConversationId: conversations.parentConversationId,
            closedAt: conversations.closedAt,
          })
          .from(conversations)
          .where(eq(conversations.id, id))
          .get(),
      ),
    list: (id) =>
      guard(() =>
        query()
          .where(and(eq(stockItems.conversationId, id), ne(stockItems.state, "cancelled")))
          .orderBy(asc(stockItems.id))
          .all()
          .map(record),
      ),
    get: (id) => guard(() => read(id)),
    add: (id, conversationId, input) =>
      guard(() => {
        database()
          .insert(stockItems)
          .values({
            id,
            conversationId,
            ...input,
            quote: JSON.stringify(input.quote),
            state: "stocked",
          })
          .run();
        return read(id)!;
      }),
    update: (id, from, to, text) =>
      guard(() => {
        const updated = database()
          .update(stockItems)
          .set({ state: to, ...(text === undefined ? {} : { text }) })
          .where(and(eq(stockItems.id, id), eq(stockItems.state, from)))
          .returning({ id: stockItems.id })
          .get();
        return updated === undefined ? undefined : read(id);
      }),
    threads: (id) =>
      guard(() =>
        database()
          .select({ conversation: conversations, stock: stockItems })
          .from(conversations)
          .innerJoin(
            stockItems,
            and(
              eq(stockItems.threadConversationId, conversations.id),
              eq(stockItems.kind, "question"),
            ),
          )
          .where(and(eq(conversations.parentConversationId, id), eq(conversations.kind, "thread")))
          .orderBy(asc(conversations.id))
          .all()
          .map(({ conversation, stock }) => ({
            id: conversation.id,
            title: conversation.title,
            stockId: stock.id,
            quote: quoteSchema.parse(JSON.parse(stock.quote ?? "null")),
            runState: conversation.runState,
            closedAt: conversation.closedAt,
            lastActivityAt: conversation.lastActivityAt,
          })),
      ),
    close: (id, at, token) =>
      guard(
        () =>
          database()
            .update(conversations)
            .set({ closedAt: at })
            .where(
              and(
                eq(conversations.id, id),
                eq(conversations.kind, "thread"),
                isNull(conversations.closedAt),
                sql`EXISTS (SELECT 1 FROM settings WHERE key=${releaseReservationKey(id)} AND json_extract(value, '$.token')=${token} AND json_extract(value, '$.expiresAt') > unixepoch('subsec') * 1000)`,
              ),
            )
            .run().changes === 1,
      ),
  };
}
