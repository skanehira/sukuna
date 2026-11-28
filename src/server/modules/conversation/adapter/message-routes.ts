import type { Handler } from "hono";
import { z } from "zod";
import { sendConversationMessageSchema } from "../../../../shared/conversation/api";
import { hasUnlocatedEdits, unlocatedConsultationNotice } from "../../../../shared/progress/draft";
import type { IdentityEnv } from "../../identity/adapter/middleware";
import type { MessageDependencies } from "../domain/message-port";

const resultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("delivered"), seq: z.number(), duplicate: z.boolean().optional() }),
  z.object({
    result: z.literal("queued"),
    queued_id: z.string(),
    duplicate: z.boolean().optional(),
  }),
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
    if (hasUnlocatedEdits(input))
      return c.json({ error: { code: "conflict", message: unlocatedConsultationNotice } }, 409);
    const accept = deps.prepareAcceptance?.(id, input);
    const result = await deps.runner.call(
      "POST",
      `/conversations/${encodeURIComponent(id)}/messages`,
      {
        ...(deps.receiptMetadata ? { receipt_metadata: true } : {}),
        ...(input.restoreDraft === undefined ? {} : { restore_draft: input.restoreDraft }),
        text: input.text,
        images: input.images,
        interrupt: input.mode === "interrupt",
        client_id: input.clientMessageId,
        origin: "developer",
        ...(input.timeline_comments === undefined
          ? {}
          : { timeline_comments: input.timeline_comments }),
        ...(input.timeline_anchors === undefined
          ? {}
          : { timeline_anchors: input.timeline_anchors }),
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
    accept?.(delivered.data.duplicate ?? false);
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
