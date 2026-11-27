import type { Handler } from "hono";
import type { IdentityEnv } from "../../identity/adapter/middleware";
import type { ProgressDependencies } from "../domain/progress-port";
import { conversationProgress } from "../usecase/conversation-progress";

export function createConversationProgressHandler(
  deps: ProgressDependencies,
): Handler<IdentityEnv> {
  return async (c) => {
    const result = await conversationProgress(c.req.param("id")!, deps);
    if (result.isErr())
      return c.json({ error: result.error }, result.error.code === "not_found" ? 404 : 500);
    return c.json(result.value);
  };
}
