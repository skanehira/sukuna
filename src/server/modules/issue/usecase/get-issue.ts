import { err, ok } from "neverthrow";
import { issueNotFound, type IssueServerDeps } from "../../../../shared/issue/ports";
export function getIssue(id: string, deps: IssueServerDeps) {
  const issue = deps.unitOfWork.read.view(id, true);
  return issue ? ok({ issue }) : err(issueNotFound);
}
