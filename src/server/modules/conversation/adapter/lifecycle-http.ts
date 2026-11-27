import { Hono } from "hono";
import type { Result } from "neverthrow";
import { closeConversationSchema, searchLifecycleQuerySchema } from "../../../../shared/lifecycle";
import type { LifecycleDependencies, LifecycleError } from "../domain/lifecycle";
import { closeConversation } from "../usecase/close";
import { deleteConversation } from "../usecase/delete";
import { getClosingSummary } from "../usecase/get-closing-summary";
import { listConversations } from "../usecase/list-conversations";
import { searchLifecycle } from "../usecase/search";

const invalid = { error: { code: "invalid_input", message: "入力を確認してください。" } };
const status = { not_found: 404, conflict: 409, runner_unavailable: 503, internal: 500 } as const;

function respond(result: Result<unknown, LifecycleError>): Response {
  return result.isOk()
    ? Response.json(result.value)
    : Response.json({ error: result.error }, { status: status[result.error.code] });
}

export function createLifecycleRoutes(deps: LifecycleDependencies) {
  const app = new Hono();
  app.onError(() =>
    Response.json(
      {
        error: {
          code: "internal",
          message: "会話の操作に失敗しました。もう一度操作してください。",
        },
      },
      { status: 500 },
    ),
  );
  app.get("/conversations/:id/closing-summary", async (c) =>
    respond(await getClosingSummary(c.req.param("id"), deps)),
  );
  app.post("/conversations/:id/close", async (c) => {
    const input = closeConversationSchema.safeParse(await c.req.json().catch(() => null));
    return input.success
      ? respond(await closeConversation(c.req.param("id"), input.data.stopIfWorking, deps))
      : c.json(invalid, 400);
  });
  app.delete("/conversations/:id", async (c) =>
    respond(await deleteConversation(c.req.param("id"), deps)),
  );
  app.get("/projects/:id/conversations", (c) =>
    respond(listConversations(c.req.param("id"), deps.repository)),
  );
  app.get("/search", (c) => {
    const query = searchLifecycleQuerySchema.safeParse(c.req.query("q"));
    return query.success
      ? c.json(searchLifecycle(query.data, deps.repository))
      : c.json(invalid, 400);
  });
  return app;
}
