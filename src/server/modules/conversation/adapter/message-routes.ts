import type { Handler } from "hono";
import { z } from "zod";
import { sendConversationMessageSchema } from "../../../../shared/conversation/api";
import type { IdentityEnv } from "../../identity/adapter/middleware";
import type { MessageDependencies } from "../domain/message-port";

const resultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("delivered"), seq: z.number() }),
  z.object({ result: z.literal("queued"), queued_id: z.string() }),
]);

export function createMessageHandler(deps: MessageDependencies): Handler<IdentityEnv> {
  return async (c) => {
    const parsed = sendConversationMessageSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    const id = c.req.param("id")!;
    if (!parsed.success)
      return c.json({ error: { code: "invalid_input", message: "入力を確認してください。" } }, 400);
    const input = parsed.data;
    const result = await deps.runner.call(
      "POST",
      `/conversations/${encodeURIComponent(id)}/messages`,
      {
        text: input.text,
        images: input.images,
        interrupt: input.mode === "interrupt",
        client_id: input.clientMessageId,
        origin: "developer",
        ...(input.timeline_comments === undefined
          ? {}
          : { timeline_comments: input.timeline_comments }),
      },
    );
    if (result.isErr()) return c.json({ error: result.error }, 503);
    if (result.value.status >= 400)
      return Response.json(result.value.body, { status: result.value.status });
    const delivered = resultSchema.safeParse(result.value.body);
    if (!delivered.success)
      return c.json(
        {
          error: {
            code: "internal",
            message: "指示の受付結果を取得できませんでした。もう一度操作してください。",
          },
        },
        500,
      );
    return c.json(
      {
        result: delivered.data.result,
        queueItem:
          delivered.data.result === "queued"
            ? deps.repository.queueItem(id, delivered.data.queued_id)
            : null,
      },
      202,
    );
  };
}
