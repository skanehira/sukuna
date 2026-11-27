import { Hono, type Context } from "hono";
import type { Result } from "neverthrow";
import type { IssueError, IssueServerDeps } from "../../../../shared/issue/ports";
import { getIssue } from "../usecase/get-issue";
import { listIssues } from "../usecase/list-issues";
import { saveDraft } from "../usecase/save-draft";
import { requestIssueOp } from "../usecase/request-issue-op";

export function createIssueRoutes(deps: IssueServerDeps): Hono {
  const app = new Hono();
  const respond = <T>(c: Context, result: Result<T, IssueError>, success: 200 | 201 = 200) => {
    const status = {
      invalid_input: 400,
      dependency_cycle: 400,
      parent_cycle: 400,
      not_found: 404,
      conflict: 409,
      confirmed_text_locked: 409,
      title_required: 400,
      runner_unavailable: 503,
      internal: 500,
    } as const;
    return result.isErr()
      ? c.json({ error: result.error }, status[result.error.code])
      : c.json(result.value, success);
  };
  app.onError((error, c) => {
    let cause = error;
    while (cause.cause instanceof Error) cause = cause.cause;
    deps.log({
      level: "error",
      component: "server.api",
      message: "issue を保存できませんでした。",
      error: cause,
    });
    return c.json(
      {
        error: {
          code: "internal",
          message: "issue を保存できませんでした。もう一度操作してください。",
        },
      },
      500,
    );
  });
  app.get("/projects/:id/issues", (c) =>
    respond(
      c,
      listIssues(
        c.req.param("id"),
        {
          state: c.req.query("state")?.split(","),
          q: c.req.query("q"),
          limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
          cursor: c.req.query("cursor") === undefined ? undefined : Number(c.req.query("cursor")),
        },
        deps,
      ),
    ),
  );
  app.post("/projects/:id/issues", async (c) =>
    respond(
      c,
      saveDraft(c.req.param("id"), null, await c.req.json().catch(() => undefined), deps),
      201,
    ),
  );
  app.get("/issues/:id", (c) => respond(c, getIssue(c.req.param("id"), deps)));
  app.patch("/issues/:id", async (c) => {
    const id = c.req.param("id");
    const issue = deps.unitOfWork.read.get(id);
    const input: unknown = await c.req.json().catch(() => undefined);
    return issue?.state === "draft"
      ? respond(c, saveDraft(issue.projectId, id, input, deps))
      : requestIssueOp(id, "edit", input, deps);
  });
  for (const operation of ["confirm", "withdraw", "reopen"] as const)
    app.post(`/issues/:id/${operation}`, (c) =>
      requestIssueOp(c.req.param("id"), operation, undefined, deps),
    );
  return app;
}
