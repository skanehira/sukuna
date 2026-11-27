import { Hono, type Context } from "hono";
import type { Result } from "neverthrow";
import { patchTocSchema, putDecisionsSchema, saveReadSchema } from "../../../../shared/recap/api";
import type { RecapDependencies, RecapError } from "../domain/ports";
import { getRecap } from "../usecase/get-recap";
import { saveRead } from "../usecase/save-read";
import { getToc, patchToc } from "../usecase/toc";
import { getDecisions, putDecisions } from "../usecase/decisions";
import { rebuild } from "../usecase/rebuild";
const invalid: RecapError = {
  code: "invalid_input",
  message: "入力の形式が正しくありません。内容を確認してください。",
};
function response<T>(c: Context, result: Result<T, RecapError>, status: 200 | 202 = 200) {
  const statuses = {
    invalid_input: 400,
    not_found: 404,
    conflict: 409,
    internal: 500,
    runner_unavailable: 503,
  } as const;
  return result.isErr()
    ? c.json({ error: result.error }, statuses[result.error.code])
    : c.json(result.value, status);
}
export function createRecapRoutes(deps: RecapDependencies): Hono {
  const app = new Hono();
  app.onError((_error, c) =>
    c.json(
      {
        error: {
          code: "internal",
          message: "会話の状況を読み書きできませんでした。もう一度操作してください。",
        },
      },
      500,
    ),
  );
  app.post("/:id/read", async (c) => {
    const parsed = saveReadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: invalid }, 400);
    const result = saveRead(c.req.param("id"), parsed.data, deps);
    return result.isErr() ? response(c, result) : c.body(null, 204);
  });
  app.get("/:id/recap", (c) => response(c, getRecap(c.req.param("id"), deps)));
  app.get("/:id/toc", (c) => response(c, getToc(c.req.param("id"), deps)));
  app.patch("/:id/toc/:position", async (c) => {
    const parsed = patchTocSchema.safeParse(await c.req.json().catch(() => null));
    const position = Number(c.req.param("position"));
    if (!parsed.success || !Number.isSafeInteger(position) || position < 1)
      return c.json({ error: invalid }, 400);
    return response(c, patchToc(c.req.param("id"), position, parsed.data, deps));
  });
  app.get("/:id/decisions", (c) => response(c, getDecisions(c.req.param("id"), deps)));
  app.put("/:id/decisions", async (c) => {
    const parsed = putDecisionsSchema.safeParse(await c.req.json().catch(() => null));
    return parsed.success
      ? response(c, putDecisions(c.req.param("id"), parsed.data, deps))
      : c.json({ error: invalid }, 400);
  });
  app.post("/:id/recap/rebuild", async (c) =>
    response(c, await rebuild(c.req.param("id"), deps), 202),
  );
  return app;
}
