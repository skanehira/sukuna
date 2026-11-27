import { Hono } from "hono";
import {
  approveDesignIpcSchema,
  rejectDesignIpcSchema,
  runnerCallerCancelled,
} from "../../../../shared/ipc";
import type { DesignFlow } from "./design-dependencies";

const status = {
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  runner_unavailable: 503,
  internal: 500,
} as const;

export function createDesignIpc(design: DesignFlow, now: () => number): Hono {
  const app = new Hono();
  app.post("/issues/:id/design/approve", async (c) => {
    const parsed = approveDesignIpcSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json(
        { error: { code: "invalid_input", message: "表示中の設計のコミットを確認してください。" } },
        400,
      );
    const result = await design.approve(
      c.req.param("id"),
      parsed.data.head_commit,
      runnerCallerCancelled(c.req.raw, now),
    );
    return result.isErr()
      ? c.json({ error: result.error }, status[result.error.code])
      : c.json(result.value, 202);
  });
  app.post("/issues/:id/design/reject", async (c) => {
    const parsed = rejectDesignIpcSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json(
        { error: { code: "invalid_input", message: "指摘は20,000字以内で書いてください。" } },
        400,
      );
    const result = await design.reject(
      c.req.param("id"),
      parsed.data,
      runnerCallerCancelled(c.req.raw, now),
    );
    return result.isErr()
      ? c.json({ error: result.error }, status[result.error.code])
      : c.json({ delivered_stock_ids: result.value.deliveredStockIds }, 202);
  });
  return app;
}
