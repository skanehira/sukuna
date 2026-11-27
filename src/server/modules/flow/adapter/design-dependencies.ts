import { and, count, eq } from "drizzle-orm";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { readDesignRecord } from "../../../../shared/db/design-reader";
import { drafts, stockItems } from "../../../../shared/db/schema";
import { createDesignGit, createGitCli } from "../../workspace/adapter/git-cli";
import type { DesignDependencies } from "../domain/design-ports";

export function createDesignDependencies(
  database: () => OpenedDatabase["db"],
  runner: () => DesignDependencies["runner"],
  log: DesignDependencies["log"],
  git = createDesignGit(createGitCli()),
): DesignDependencies {
  return {
    read: (id) =>
      database().transaction((tx) => {
        const record = readDesignRecord(tx, id);
        if (!record) return null;
        const unsentInstructionCount = record.conversation
          ? tx
              .select({ count: count() })
              .from(stockItems)
              .where(
                and(
                  eq(stockItems.conversationId, record.conversation.id),
                  eq(stockItems.kind, "instruction"),
                  eq(stockItems.state, "stocked"),
                ),
              )
              .get()!.count
          : 0;
        const draft = record.conversation
          ? tx.select().from(drafts).where(eq(drafts.conversationId, record.conversation.id)).get()
          : undefined;
        return { ...record, unsentInstructionCount, draft };
      }),
    git,
    runner: { forward: (method, path, input) => runner().forward(method, path, input) },
    log,
  };
}
