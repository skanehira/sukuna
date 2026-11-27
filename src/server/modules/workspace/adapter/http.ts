import { Hono, type Context } from "hono";
import type { Result } from "neverthrow";
import type { WorkspaceDependencies, WorkspaceError } from "../domain/ports";
import { listFiles } from "../usecase/list-files";
import { listChanges } from "../usecase/list-changes";
import { readFile } from "../usecase/read-file";
import { searchContent } from "../usecase/search-content";

function response<T>(c: Context, result: Result<T, WorkspaceError>) {
  const status = { invalid_input: 400, not_found: 404, conflict: 409, internal: 500 } as const;
  if (result.isErr()) return c.json({ error: result.error }, status[result.error.code]);
  return c.json(result.value);
}

export function createWorkspaceRoutes(deps: WorkspaceDependencies): Hono {
  const app = new Hono();
  app.get("/:id/files", async (c) => {
    return response(c, await listFiles(c.req.param("id"), deps));
  });
  app.get("/:id/files/content", async (c) =>
    response(c, await readFile(c.req.param("id"), c.req.query("path") ?? "", deps)),
  );
  app.get("/:id/changes", async (c) => response(c, await listChanges(c.req.param("id"), deps)));
  app.get("/:id/search", async (c) =>
    response(
      c,
      await searchContent(
        c.req.param("id"),
        { mode: c.req.query("mode") ?? "", q: c.req.query("q") ?? "" },
        deps,
      ),
    ),
  );
  return app;
}
