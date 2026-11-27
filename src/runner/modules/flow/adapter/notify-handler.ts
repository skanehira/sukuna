import { Hono } from "hono";
import { flowNotifySchema } from "../../../../shared/ipc";

export function createFlowNotifyHandler(
  notify: (input: { project_id?: string; issue_id?: string }) => void,
) {
  const app = new Hono();
  app.post("/notify", async (c) => {
    const input = flowNotifySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success)
      return c.json(
        {
          error: {
            code: "invalid_input",
            message: "評価する issue またはプロジェクトを確認してください。",
          },
        },
        400,
      );
    notify(input.data);
    return c.json({});
  });
  return app;
}
