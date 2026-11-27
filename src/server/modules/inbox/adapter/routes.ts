import { Hono } from "hono";
import type { InboxDependencies } from "../domain/ports";
import { buildInbox } from "../usecase/build-inbox";
import { buildTree } from "../usecase/build-tree";
import { buildOverview } from "../usecase/build-overview";
export function createInboxRoutes(deps: InboxDependencies) {
  const app = new Hono();
  app.onError((_error, c) =>
    c.json(
      { error: { code: "internal", message: "一覧を取得できませんでした。読み直してください。" } },
      500,
    ),
  );
  app.get("/inbox", (c) => {
    const snapshot = deps.repository.load();
    if (snapshot.isErr()) return c.json({ error: snapshot.error }, 500);
    return c.json(buildInbox(snapshot.value, deps));
  });
  app.get("/projects", (c) => {
    const snapshot = deps.repository.load();
    if (snapshot.isErr()) return c.json({ error: snapshot.error }, 500);
    return c.json(buildTree(snapshot.value));
  });
  app.get("/projects/:id/overview", (c) => {
    const snapshot = deps.repository.load();
    if (snapshot.isErr()) return c.json({ error: snapshot.error }, 500);
    const project = snapshot.value.projects.find((p) => p.id === c.req.param("id"));
    if (project === undefined)
      return c.json(
        {
          error: {
            code: "not_found",
            message: "プロジェクトが見つかりません。読み直してください。",
          },
        },
        404,
      );
    return c.json(
      buildOverview(project, deps, snapshot.value.flowPaused, c.req.query("closed") === "all"),
    );
  });
  return app;
}
