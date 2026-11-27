import { err, ok, type Result } from "neverthrow";
import {
  issueConflict,
  issueNotFound,
  type IssueError,
  type IssueServerDeps,
} from "../../../../shared/issue/ports";
import { issueInputSchema } from "../../../../shared/issue/schema";
import { prepareIssueWrite } from "../../../../shared/issue/rules";

export function validateIssueOperation(
  id: string,
  operation: "confirm" | "withdraw" | "reopen" | "edit",
  input: unknown,
  deps: IssueServerDeps,
): Result<unknown, IssueError> {
  const repo = deps.unitOfWork.read;
  const issue = repo.get(id);
  if (!issue || !repo.project(issue.projectId)) return err(issueNotFound);
  const closed = issue.state === "done" || issue.state === "withdrawn";
  if (operation === "confirm") {
    if (issue.state !== "draft") return err(issueConflict);
    if (!issue.title.trim())
      return err({ code: "title_required", message: "題名を書いてから確定してください" });
  } else if (operation === "reopen" ? !closed : closed) return err(issueConflict);
  if (operation !== "edit") return ok(undefined);
  const parsed = issueInputSchema.safeParse(input);
  if (!parsed.success)
    return err({ code: "invalid_input", message: "入力の長さ・番号・件数を確認してください。" });
  if (parsed.data.title !== undefined || parsed.data.body !== undefined)
    return err({
      code: "confirmed_text_locked",
      message: "確定した issue の題名と本文は、会話で AI に頼んで直します",
    });
  if (parsed.data.priority === null)
    return err({ code: "invalid_input", message: "確定した issue の優先度は無しに戻せません" });
  const prepared = prepareIssueWrite(
    issue,
    parsed.data,
    repo.all(issue.projectId),
    repo.graph(issue.projectId),
  );
  if (prepared.error) return err(prepared.error);
  const p = parsed.data;
  return ok({
    ...(p.parentNumber === undefined ? {} : { parent_number: p.parentNumber }),
    ...(p.dependsOn === undefined ? {} : { depends_on: p.dependsOn }),
    ...(p.priority === undefined ? {} : { priority: p.priority }),
    ...(p.confirmBeforeMerge === undefined ? {} : { confirm_before_merge: p.confirmBeforeMerge }),
  });
}
export async function requestIssueOp(
  id: string,
  operation: "confirm" | "withdraw" | "reopen" | "edit",
  input: unknown,
  deps: IssueServerDeps,
): Promise<Response> {
  const validated = validateIssueOperation(id, operation, input, deps);
  if (validated.isErr()) {
    const error = validated.error;
    const status =
      error.code === "not_found"
        ? 404
        : ["conflict", "confirmed_text_locked"].includes(error.code)
          ? 409
          : 400;
    return Response.json({ error }, { status });
  }
  const response = await deps.runner.forward(
    operation === "edit" ? "PATCH" : "POST",
    `/flow/issues/${id}${operation === "edit" ? "" : `/${operation}`}`,
    validated.value,
  );
  if (!response.ok) return response;
  const body = (await response.json()) as { issue: unknown; stopped_dependents?: number[] };
  return Response.json({
    issue: body.issue,
    ...(body.stopped_dependents === undefined
      ? {}
      : { stoppedDependents: body.stopped_dependents }),
  });
}
