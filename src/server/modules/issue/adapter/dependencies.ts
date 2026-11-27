import { ulid } from "ulid";
import type { OpenedDatabase } from "../../../../shared/db/open";
import type { IssueClock, IssueRunnerPort, IssueServerDeps } from "../../../../shared/issue/ports";
import { createIssueDataUnitOfWork } from "./issue-repository";
import type { Logger } from "../../../../shared/log";
export function createIssueDependencies(
  database: () => OpenedDatabase["db"],
  runner: () => IssueRunnerPort,
  log: Logger,
  clock: IssueClock = { now: Date.now, id: ulid },
  changed: IssueServerDeps["changed"] = () => {},
): IssueServerDeps {
  return {
    get unitOfWork() {
      return createIssueDataUnitOfWork(database());
    },
    clock,
    log,
    runner: { forward: (method, path, input) => runner().forward(method, path, input) },
    changed,
  };
}
