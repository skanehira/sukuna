import { and, eq } from "drizzle-orm";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { queuedInstructions } from "../../../../shared/db/schema";
import type { MessageDependencies } from "../domain/message-port";

export function createMessageRepository(
  db: OpenedDatabase["db"],
): MessageDependencies["repository"] {
  return {
    queueItem: (conversationId, itemId) => {
      const row = db
        .select()
        .from(queuedInstructions)
        .where(
          and(
            eq(queuedInstructions.conversationId, conversationId),
            eq(queuedInstructions.id, itemId),
          ),
        )
        .get();
      if (!row) return null;
      const { conversationId: _conversationId, timelineComments, ...item } = row;
      return {
        ...item,
        ...(timelineComments === null ? {} : { timeline_comments: timelineComments }),
      };
    },
  };
}
