import { Hono, type Context } from "hono";
import { err, type Result } from "neverthrow";
import { createWorktreeSchema } from "../../../../shared/api/worktree";
import { openTerminalSchema } from "../../../../shared/api/terminal";
import type { WorktreeDependencies, WorktreeError } from "../domain/worktree-ports";
import { WORKTREE_NAME_RULE } from "../domain/worktree-rules";
import { listWorktrees } from "../usecase/list-worktrees";
import { createWorktree } from "../usecase/create-worktree";
import { removeWorktree } from "../usecase/remove-worktree";
import { openTerminal } from "../usecase/open-terminal";

function response<T>(c: Context, result: Result<T, WorktreeError>, status: 200 | 201 = 200) {
  const statuses = {
    invalid_input: 400,
    not_found: 404,
    conflict: 409,
    internal: 500,
    worktree_failed: 500,
  } as const;
  return result.isErr()
    ? c.json({ error: result.error }, statuses[result.error.code])
    : c.json(result.value, status);
}
export function createWorktreeRoutes(deps: WorktreeDependencies): Hono {
  const app = new Hono();
  app.onError((_error, c) =>
    c.json({ error: { code: "internal", message: "worktree の操作に失敗しました" } }, 500),
  );
  app.get("/projects/:id/worktrees", async (c) =>
    response(c, await listWorktrees(c.req.param("id"), deps)),
  );
  app.post("/projects/:id/worktrees", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return response(c, err({ code: "invalid_input", message: WORKTREE_NAME_RULE }));
    }
    const parsed = createWorktreeSchema.safeParse(body);
    if (!parsed.success)
      return response(c, err({ code: "invalid_input", message: WORKTREE_NAME_RULE }));
    return response(c, await createWorktree(c.req.param("id"), parsed.data.name, deps), 201);
  });
  app.delete("/worktrees/:id", async (c) =>
    response(c, await removeWorktree(c.req.param("id"), deps)),
  );
  const terminals = deps.terminals;
  if (terminals)
    app.post("/terminals", async (c) => {
      const origin = c.req.header("origin");
      if (origin !== undefined && origin !== new URL(c.req.url).origin)
        return c.json(
          { error: { code: "unauthorized", message: "アプリを開いた画面から接続してください。" } },
          401,
        );
      const body = await c.req.json<unknown>().catch(() => undefined);
      const parsed = openTerminalSchema.safeParse(body);
      if (!parsed.success) {
        const invalidSize = parsed.error.issues.some(
          ({ path }) => path[0] === "cols" || path[0] === "rows",
        );
        return response(
          c,
          err({
            code: "invalid_input",
            message: invalidSize
              ? "端末の大きさは 2〜500 列、1〜200 行で指定してください"
              : "ターミナルを開くための指定を確かめてください。",
          }),
        );
      }
      const opened = openTerminal(parsed.data, terminals);
      return response(c, opened, opened.isOk() && !opened.value.reused ? 201 : 200);
    });
  return app;
}
