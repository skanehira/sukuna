import { and, asc, eq } from "drizzle-orm";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { stockItems } from "../../../../shared/db/schema";
import { quoteSchema } from "../../../../shared/stock";
import type { OutgoingStockRepository } from "../domain/ports";

export function createOutgoingStockRepository(db: OpenedDatabase["db"]): OutgoingStockRepository {
  return {
    list: (conversationId) =>
      db
        .select({
          id: stockItems.id,
          conversationId: stockItems.conversationId,
          kind: stockItems.kind,
          text: stockItems.text,
          quote: stockItems.quote,
        })
        .from(stockItems)
        .where(and(eq(stockItems.conversationId, conversationId), eq(stockItems.state, "stocked")))
        .orderBy(asc(stockItems.id))
        .all()
        .map((row) => ({ ...row, quote: quoteSchema.parse(JSON.parse(row.quote ?? "null")) })),
    markSent: (item, receipt) =>
      db
        .update(stockItems)
        .set({
          state: "sent",
          sentAt: receipt.at,
          sentSeq: receipt.seq ?? null,
          threadConversationId: receipt.threadId ?? null,
        })
        .where(
          and(
            eq(stockItems.id, item.id),
            eq(stockItems.conversationId, item.conversationId),
            eq(stockItems.kind, item.kind),
            eq(stockItems.state, "stocked"),
            eq(stockItems.text, item.text),
          ),
        )
        .run().changes === 1,
  };
}
