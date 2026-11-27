import { Hono, type Context } from "hono";
import type { PrDependencies, PrError } from "../domain/pr-ports";
import type { Result } from "neverthrow";
import { getPr } from "../usecase/get-pr";
import { allowMerge } from "../usecase/allow-merge";
import { publishComments } from "../usecase/publish-comments";
export function createPrRoutes(deps: PrDependencies): Hono {
  const app = new Hono();
  const respond = <T>(c: Context, r: Result<T, PrError>) =>
    r.isErr()
      ? c.json(
          { error: r.error },
          {
            not_found: 404,
            invalid_input: 400,
            conflict: 409,
            github_unavailable: 502,
            runner_unavailable: 503,
            internal: 500,
          }[r.error.code] as 400 | 404 | 409 | 502 | 503 | 500,
        )
      : c.json(r.value);
  app.get("/issues/:id/pr", async (c) => respond(c, await getPr(c.req.param("id"), deps)));
  app.post("/issues/:id/pr/allow-merge", async (c) => {
    const r = await allowMerge(c.req.param("id"), await c.req.json().catch(() => undefined), deps);
    if (r.isErr()) return respond(c, r);
    const response = r.value;
    return response.ok ? c.json(await response.json(), 202) : response;
  });
  app.post("/issues/:id/pr/comments/publish", async (c) =>
    respond(
      c,
      await publishComments(c.req.param("id"), await c.req.json().catch(() => undefined), deps),
    ),
  );
  app.onError((_e, c) =>
    c.json(
      {
        error: { code: "internal", message: "PR の操作に失敗しました。もう一度操作してください。" },
      },
      500,
    ),
  );
  return app;
}
