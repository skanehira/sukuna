import { asc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  conversations,
  conversationEvents,
  issues,
  projects,
  settings,
} from "../../../../shared/db/schema";
import { getUsage, type UsageDependencies } from "../usecase/get-usage";

export function createUsageDependencies(
  database: () => OpenedDatabase["db"],
  now = Date.now,
): UsageDependencies {
  return {
    now,
    read(from, until, consume) {
      return database().transaction((db) => {
        const active = db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(isNull(projects.removedAt))
          .all();
        const threads = db
          .select({
            id: conversations.id,
            projectId: conversations.projectId,
            issueId: conversations.issueId,
            parentConversationId: conversations.parentConversationId,
          })
          .from(conversations)
          .all();
        const items = db
          .select({
            id: issues.id,
            projectId: issues.projectId,
            title: issues.title,
            number: issues.number,
          })
          .from(issues)
          .all();
        const reading = db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, "usage.rate_limit"))
          .get();

        const turns = db
          .select({
            conversationId: conversationEvents.conversationId,
            createdAt: conversationEvents.createdAt,
            payload: conversationEvents.payload,
            previousCost: sql<number | null>`(
            SELECT json_extract(prior.payload, '$.cost_usd') FROM conversation_events AS prior
            WHERE prior.conversation_id = conversation_events.conversation_id
              AND prior.seq < conversation_events.seq AND prior.type = 'turn_end'
            ORDER BY prior.seq DESC LIMIT 1
          )`,
          })
          .from(conversationEvents)
          .where(sql`${conversationEvents.type} = 'turn_end'
            AND ${conversationEvents.createdAt} BETWEEN ${from} AND ${until}`)
          .orderBy(asc(conversationEvents.conversationId), asc(conversationEvents.seq))
          .all();
        return consume({
          projects: active,
          conversations: threads,
          issues: items,
          turns,
          rateLimit: reading?.value,
        });
      });
    },
  };
}

export function createUsageRoutes(deps: UsageDependencies) {
  return new Hono().get("/usage", (c) => c.json(getUsage(deps)));
}
