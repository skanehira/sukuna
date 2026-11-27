import { createWorktreeActivity } from "../../../../shared/workspace/sqlite-worktree-activity";
import type { OpenedDatabase } from "../../../../shared/db/open";
import {
  createIssueDataRepository,
  createIssueDataUnitOfWork,
} from "../../../../server/modules/issue/adapter/issue-repository";
import { createIssueUnitOfWork, createIssueRepository } from "./issue-repository";
import { createDependencyWithdrawn } from "../usecase/dependency-withdrawn";
import { createIssueOps } from "../usecase/issue-ops";
import type { IssueClock } from "../../../../shared/issue/ports";
import type { IssueNoticePort, StopConversationPort } from "../domain/ports";
export function createIssueOperations(
  database: OpenedDatabase,
  clock: IssueClock,
  notices: IssueNoticePort,
  conversations: StopConversationPort,
  hasDesignWorktree?: (id: string) => boolean,
) {
  const { db } = database;
  const dependency = createDependencyWithdrawn({
    unitOfWork: createIssueUnitOfWork(database),
    clock,
    notices,
    conversations,
  });
  return createIssueOps({
    data: createIssueDataUnitOfWork(db),
    clock,
    notices,
    withdraw: dependency.withdraw,
    clear: dependency.clear,
    hasDesignWorktree,
    run: (action) =>
      createWorktreeActivity(database.sqlite.name).run((reservation) =>
        db.transaction(
          (tx) => action(createIssueDataRepository(tx), createIssueRepository(tx, reservation)),
          {
            behavior: "immediate",
          },
        ),
      ),
  });
}
