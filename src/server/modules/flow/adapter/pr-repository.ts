import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  issues,
  projects,
  conversations,
  worktrees,
  issueEvents,
  prSnapshots,
  stockItems,
} from "../../../../shared/db/schema";
import { prResponseSchema } from "../../../../shared/api/pr";
import { quoteSchema } from "../../../../shared/stock";
import { objectOf } from "../../../../shared/activity/stage";
import type { PrRepository } from "../domain/pr-ports";
export function createPrRepository(
  db: Pick<OpenedDatabase["db"], "select" | "insert" | "update">,
): PrRepository {
  return {
    context(id) {
      const issue = db.select().from(issues).where(eq(issues.id, id)).get();
      if (!issue) return;
      const project = db
        .select()
        .from(projects)
        .where(and(eq(projects.id, issue.projectId), isNull(projects.removedAt)))
        .get();
      if (!project) return;
      const conversation = db
        .select()
        .from(conversations)
        .where(and(eq(conversations.issueId, id), eq(conversations.kind, "impl")))
        .orderBy(desc(conversations.id))
        .get();
      const worktree = db
        .select()
        .from(worktrees)
        .where(and(eq(worktrees.issueId, id), isNull(worktrees.removedAt)))
        .orderBy(desc(worktrees.id))
        .get();
      const events = db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, id))
        .orderBy(asc(issueEvents.seq))
        .all();
      const stopped = events.findLast(
        (e) =>
          e.type === "state_changed" &&
          objectOf(e.payload).to === "stopped" &&
          objectOf(e.payload).from !== "stopped",
      );
      return {
        issue,
        project,
        implConversationId: conversation?.id ?? null,
        worktree: worktree
          ? { id: worktree.id, path: worktree.path, branch: worktree.branch }
          : null,
        earlierPrUrls: events
          .filter((e) => e.type === "reopened_for_fix")
          .flatMap((e) => {
            const u = objectOf(e.payload).previousPrUrl;
            return typeof u === "string" ? [u] : [];
          }),
        unsentInstructionCount: conversation
          ? db
              .select()
              .from(stockItems)
              .where(
                and(
                  eq(stockItems.conversationId, conversation.id),
                  eq(stockItems.kind, "instruction"),
                  eq(stockItems.state, "stocked"),
                ),
              )
              .all().length
          : 0,
        stoppedFromImplementation: objectOf(stopped?.payload).from === "implementing",
      };
    },
    snapshot(id, url) {
      const row = db
        .select()
        .from(prSnapshots)
        .where(and(eq(prSnapshots.issueId, id), eq(prSnapshots.prUrl, url)))
        .get();
      return row ? prResponseSchema.parse(row.payload) : null;
    },
    saveSnapshot(id, url, payload) {
      db.insert(prSnapshots)
        .values({ issueId: id, prUrl: url, payload, fetchedAt: payload.fetchedAt })
        .onConflictDoUpdate({
          target: prSnapshots.issueId,
          set: { prUrl: url, payload, fetchedAt: payload.fetchedAt },
        })
        .run();
    },
    stocks(ids) {
      if (!ids.length) return [];
      return db
        .select()
        .from(stockItems)
        .where(and(inArray(stockItems.id, ids), inArray(stockItems.state, ["stocked", "sent"])))
        .all()
        .map((s) => ({
          ...s,
          quote: s.quote === null ? null : quoteSchema.parse(JSON.parse(s.quote)),
        }));
    },
    markPublished(items) {
      for (const item of items)
        db.update(stockItems)
          .set({ githubCommentUrl: item.url })
          .where(eq(stockItems.id, item.stockId))
          .run();
    },
  };
}
