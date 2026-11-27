import { err, ok, type Result } from "neverthrow";
import {
  issueConflict,
  issueNotFound,
  type IssueError,
  type IssueServerDeps,
} from "../../../../shared/issue/ports";
import { type IssueView } from "../../../../shared/issue/schema";
import { validateIssueInput, prepareIssueWrite, newIssue } from "../../../../shared/issue/rules";

export function saveDraft(
  projectId: string,
  id: string | null,
  input: unknown,
  deps: IssueServerDeps,
): Result<{ issue: IssueView }, IssueError> {
  const parsed = validateIssueInput(input);
  if (!parsed)
    return err({ code: "invalid_input", message: "入力の長さ・番号・件数を確認してください。" });
  const action = id === null ? deps.unitOfWork.create : deps.unitOfWork.run;
  const result = action((repository) => {
    const project = repository.project(projectId);
    if (!project) return err(issueNotFound);
    const now = deps.clock.now();
    const issue =
      id === null
        ? newIssue(
            deps.clock.id(),
            projectId,
            repository.nextNumber(projectId),
            now,
            project.confirmBeforeMergeDefault,
          )
        : repository.get(id);
    if (!issue) return err(issueNotFound);
    if (issue.state !== "draft") return err(issueConflict);
    const prepared = prepareIssueWrite(
      issue,
      parsed,
      repository.all(projectId),
      repository.graph(projectId),
    );
    if (prepared.error) return err(prepared.error);
    const fields = { ...prepared.fields, updatedAt: now };
    if (id === null) repository.insert({ ...issue, ...fields }, prepared.dependencies);
    else repository.update(id, fields, prepared.dependencies);
    return ok({ issue: repository.view(issue.id)! });
  });
  if (result.isOk()) deps.changed(result.value.issue.id, projectId);
  return result;
}
