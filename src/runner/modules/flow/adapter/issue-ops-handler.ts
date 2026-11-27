import { Hono, type Context } from "hono";
import type { IssueOps } from "../usecase/issue-ops";
import type { IssueOperationResult } from "../../../../shared/issue/ports";
import { issuePatchIpcSchema } from "../../../../shared/ipc";
export function createIssueOpsHandler(ops: IssueOps): Hono {
  const app = new Hono();
  const respond = (c: Context, result: IssueOperationResult) => {
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
    if (result.isErr()) return c.json({ error: result.error }, status[result.error.code]);
    const { issue, stoppedDependents } = result.value;
    return c.json({
      issue,
      ...(stoppedDependents === undefined ? {} : { stopped_dependents: stoppedDependents }),
    });
  };
  for (const operation of ["confirm", "withdraw", "reopen"] as const)
    app.post(`/issues/:id/${operation}`, async (c) =>
      respond(c, await ops[operation](c.req.param("id"))),
    );
  app.patch("/issues/:id", async (c) => {
    const parsed = issuePatchIpcSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json(
        { error: { code: "invalid_input", message: "入力の長さ・番号・件数を確認してください。" } },
        400,
      );
    const p = parsed.data;
    return respond(
      c,
      ops.edit(c.req.param("id"), {
        ...(p.parent_number === undefined ? {} : { parentNumber: p.parent_number }),
        ...(p.depends_on === undefined ? {} : { dependsOn: p.depends_on }),
        ...(p.priority === undefined ? {} : { priority: p.priority }),
        ...(p.confirm_before_merge === undefined
          ? {}
          : { confirmBeforeMerge: p.confirm_before_merge }),
      }),
    );
  });
  return app;
}
