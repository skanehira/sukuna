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
  db: OpenedDatabase["db"],
  clock: IssueClock,
  notices: IssueNoticePort,
  conversations: StopConversationPort,
) {
  const dependency = createDependencyWithdrawn({
    unitOfWork: createIssueUnitOfWork(db),
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
    run: (action) =>
      db.transaction((tx) => action(createIssueDataRepository(tx), createIssueRepository(tx)), {
        behavior: "immediate",
      }),
  });
}
