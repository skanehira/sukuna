import { Hono, type Context } from "hono";
import type { Result } from "neverthrow";
import type { DesignError } from "../../../../shared/api/design";
import type { DesignDependencies } from "../domain/design-ports";
import { getDesign } from "../usecase/get-design";
import { approveDesign } from "../usecase/approve-design";
import { rejectDesign } from "../usecase/reject-design";

const status = {
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  runner_unavailable: 503,
  internal: 500,
} as const;

export function createDesignRoutes(deps: DesignDependencies): Hono {
  const app = new Hono();
  const respond = <T>(c: Context, result: Result<T, DesignError>) =>
    result.isErr()
      ? c.json({ error: result.error }, status[result.error.code])
      : result.value instanceof Response
        ? result.value
        : c.json(result.value);
  app.onError((error, c) => {
    deps.log({
      level: "error",
      component: "server.api",
      message: "設計の操作に失敗しました。",
      error,
    });
    return c.json(
      {
        error: {
          code: "internal",
          message: "設計の操作に失敗しました。もう一度操作してください。",
        },
      },
      500,
    );
  });
  app.get("/issues/:id/design", async (c) => respond(c, await getDesign(c.req.param("id"), deps)));
  app.post("/issues/:id/design/approve", async (c) =>
    respond(
      c,
      await approveDesign(c.req.param("id"), await c.req.json().catch(() => undefined), deps),
    ),
  );
  app.post("/issues/:id/design/reject", async (c) =>
    respond(
      c,
      await rejectDesign(c.req.param("id"), await c.req.json().catch(() => undefined), deps),
    ),
  );
  return app;
}
