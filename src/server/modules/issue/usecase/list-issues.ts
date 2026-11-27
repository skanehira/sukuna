import { err, ok } from "neverthrow";
import { issueNotFound, type IssueServerDeps } from "../../../../shared/issue/ports";
import { issueListSchema } from "../../../../shared/issue/schema";
export function listIssues(projectId: string, input: unknown, deps: IssueServerDeps) {
  const parsed = issueListSchema.safeParse(input);
  if (!parsed.success)
    return err({ code: "invalid_input" as const, message: "一覧の条件を確認してください。" });
  const repo = deps.unitOfWork.read;
  return repo.project(projectId) ? ok(repo.list(projectId, parsed.data)) : err(issueNotFound);
}
