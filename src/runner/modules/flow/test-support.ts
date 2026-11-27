import { afterEach, beforeEach } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { conversations, issueDependencies, issueEvents, issues } from "../../../shared/db/schema";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../shared/db/test-helpers";
import { createIssueUnitOfWork } from "./adapter/issue-repository";
import type { IssueNotice } from "./domain/ports";

export function flowFixture() {
  let home: string;
  let opened: OpenedDatabase;
  const notices: IssueNotice[] = [];
  const stopped: string[] = [];
  const noticeTransactions: boolean[] = [];
  const stopTransactions: boolean[] = [];
  beforeEach(() => {
    home = createTempHome();
    opened = openMigratedDatabase(home);
    notices.length = 0;
    stopped.length = 0;
    noticeTransactions.length = 0;
    stopTransactions.length = 0;
  });
  afterEach(() => {
    opened.close();
    removeTempHome(home);
  });

  return {
    get opened() {
      return opened;
    },
    get deps() {
      return {
        unitOfWork: createIssueUnitOfWork(opened.db),
        clock: { now: () => 1000 },
        notices: {
          publish: (notice: IssueNotice) => {
            noticeTransactions.push(opened.sqlite.inTransaction);
            notices.push(notice);
          },
        },
        conversations: {
          stop: async (id: string) => {
            stopTransactions.push(opened.sqlite.inTransaction);
            stopped.push(id);
          },
        },
      };
    },
    notices,
    stopped,
    noticeTransactions,
    stopTransactions,
    addIssue(id: string, number: number, values: Partial<typeof issues.$inferInsert> = {}) {
      opened.db
        .insert(issues)
        .values({
          id,
          projectId: "project",
          number,
          title: id,
          state: "design",
          createdAt: 1,
          updatedAt: 1,
          ...values,
        })
        .run();
    },
    issue(id: string) {
      return opened.db.select().from(issues).where(eq(issues.id, id)).get();
    },
    events(id: string) {
      return opened.db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, id))
        .orderBy(issueEvents.seq)
        .all();
    },
    depend(issueId: string, dependsOnId: string) {
      opened.db.insert(issueDependencies).values({ issueId, dependsOnId }).run();
    },
    removeDependency(issueId: string) {
      opened.db.delete(issueDependencies).where(eq(issueDependencies.issueId, issueId)).run();
    },
    addConversation(
      id: string,
      issueId: string,
      values: Partial<typeof conversations.$inferInsert> = {},
    ) {
      opened.db
        .insert(conversations)
        .values({
          id,
          projectId: "project",
          kind: "design",
          issueId,
          cwd: "/repo",
          runState: "working",
          ...values,
        })
        .run();
    },
  };
}
