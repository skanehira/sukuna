import { and, asc, eq } from "drizzle-orm";
import { Result } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { conversationEvents, conversations } from "../../../../shared/db/schema";
import { diffSchema } from "../../../../shared/events";
import type { WorkspaceRepositoryPort } from "../domain/ports";

export function createWorkspaceRepository(
  database: () => OpenedDatabase["db"],
): WorkspaceRepositoryPort {
  return {
    conversation: (id) =>
      Result.fromThrowable(
        () =>
          database()
            .select({ cwd: conversations.cwd })
            .from(conversations)
            .where(eq(conversations.id, id))
            .get(),
        () => ({ code: "internal" as const, message: "会話を読み取れませんでした" }),
      )(),
    diffs: (id) =>
      Result.fromThrowable(
        () =>
          database()
            .select({
              seq: conversationEvents.seq,
              createdAt: conversationEvents.createdAt,
              payload: conversationEvents.payload,
            })
            .from(conversationEvents)
            .where(
              and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, "diff")),
            )
            .orderBy(asc(conversationEvents.seq))
            .all()
            .map((row) => ({ ...row, payload: diffSchema.parse(row.payload) })),
        () => ({ code: "internal" as const, message: "会話の差分を読み取れませんでした" }),
      )(),
  };
}
