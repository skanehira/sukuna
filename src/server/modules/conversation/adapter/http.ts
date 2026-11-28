import { Hono } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  editableConversationContentSchema,
  eventPageSchema,
  permissionDecisionSchema,
  saveConversationAnswersSchema,
  saveConversationDraftSchema,
  sendConversationAnswersSchema,
  startPublicConversationSchema,
  switchPublicWorkspaceSchema,
} from "../../../../shared/conversation/api";
import {
  emptyDraft,
  missingConversation,
  type ConversationDependencies,
  type ConversationWorktrees,
} from "../domain/ports";
import { createMessageHandler } from "./message-routes";
import { startConversation } from "../usecase/start-conversation";
import { switchWorkspace } from "../usecase/switch-workspace";
import { prepareMessageAcceptance } from "../usecase/send-message";
import { saveDraft } from "../usecase/save-draft";
import { saveAnswers, sendAnswers } from "../usecase/answers";
import { validTimelineAnchors } from "../../../../shared/progress/draft";
import { editQueue, cancelQueue } from "../usecase/edit-queue";
import { uploadImage } from "../usecase/upload-image";
import { readImage } from "../usecase/read-image";
import { resumeConversation } from "../usecase/resume";
import type { Context } from "hono";
const invalid = { code: "invalid_input", message: "入力を確認してください。" };
function respond(
  c: Context,
  result: Result<unknown, { code: string; message: string }>,
  status = 200,
): Response {
  if (result.isErr())
    return c.json(
      { error: result.error },
      result.error.code === "not_found"
        ? 404
        : result.error.code === "invalid_input"
          ? 400
          : result.error.code === "runner_unavailable"
            ? 503
            : result.error.code === "internal" || result.error.code === "worktree_failed"
              ? 500
              : 409,
    );
  if (status === 204) return c.body(null, 204);
  return Response.json(result.value, { status });
}
function wire(
  c: Context,
  result: Result<{ status: number; body: unknown }, { code: string; message: string }>,
): Response {
  return result.isErr()
    ? respond(c, result)
    : Response.json(result.value.body, { status: result.value.status });
}
export function createConversationRoutes(
  deps: ConversationDependencies,
  worktrees?: ConversationWorktrees,
) {
  const app = new Hono();
  app.onError((_error, c) =>
    c.json(
      {
        error: {
          code: "internal",
          message: "会話の操作に失敗しました。もう一度操作してください。",
        },
      },
      500,
    ),
  );
  const body = async <S extends z.ZodType>(c: Context, schema: S) =>
    schema.safeParse(await c.req.json().catch(() => undefined));
  app.post("/conversations", async (c) => {
    const input = await body(c, startPublicConversationSchema);
    return input.success
      ? wire(c, await startConversation(input.data, deps, worktrees))
      : c.json({ error: invalid }, 400);
  });
  app.use("/conversations/:id/*", async (c, next) => {
    if (!deps.repository.conversation(c.req.param("id")!))
      return c.json({ error: missingConversation }, 404);
    await next();
  });
  app.put("/conversations/:id/workspace", async (c) => {
    const input = await body(c, switchPublicWorkspaceSchema);
    return input.success
      ? wire(c, await switchWorkspace(c.req.param("id"), input.data.worktreeId, deps, worktrees))
      : c.json({ error: invalid }, 400);
  });
  app.get("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const conversation = deps.repository.conversation(id);
    if (!conversation) return c.json({ error: missingConversation }, 404);
    const commands = await deps.runner.call(
      "GET",
      `/conversations/${encodeURIComponent(id)}/commands`,
    );
    const permission =
      conversation.runState === "waiting_permission"
        ? deps.repository
            .events(id, 0, Number.MAX_SAFE_INTEGER)
            .findLast((e) => e.type === "permission_request")
        : undefined;
    const request = permission?.type === "permission_request" ? permission : undefined;
    const input = request?.payload.input as Record<string, unknown> | undefined;
    return c.json({
      conversation,
      draft: emptyDraft(deps.repository.draft(id)),
      queue: deps.repository.queue(id),
      pendingAnswers: deps.repository.pendingAnswers(id),
      pendingPermission: request
        ? {
            requestId: request.payload.request_id,
            seq: request.seq,
            toolName: request.payload.tool_name,
            summary:
              request.payload.title ??
              (typeof input?.command === "string"
                ? input.command
                : typeof input?.file_path === "string"
                  ? input.file_path
                  : ""),
          }
        : null,
      commands:
        commands.isOk() && commands.value.status < 400
          ? z
              .object({
                commands: z.array(z.object({ name: z.string(), description: z.string() })),
              })
              .parse(commands.value.body).commands
          : [],
    });
  });
  app.get("/conversations/:id/events", (c) => {
    const parsed = eventPageSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: invalid }, 400);
    const id = c.req.param("id");
    const { after, limit } = parsed.data;
    const events = deps.repository.events(id, after, limit + 1);
    return c.json({
      events: events.slice(0, limit).map(({ seq, type, payload, createdAt }) => ({
        seq,
        type,
        payload,
        createdAt,
        ...(type === "user_message"
          ? {
              missingImages: payload.images.filter((image) => !deps.images.exists(image.path))
                .length,
            }
          : {}),
      })),
      lastSeq: deps.repository.conversation(id)!.lastSeq,
      hasMore: events.length > limit,
    });
  });
  app.post(
    "/conversations/:id/messages",
    createMessageHandler({
      receiptMetadata: true,
      runner: deps.runner,
      repository: {
        queueItem: (id, itemId) =>
          deps.repository.queue(id).find((item) => item.id === itemId) ?? null,
      },
      prepareAcceptance: (id, input) => prepareMessageAcceptance(id, input, deps),
    }),
  );
  app.put("/conversations/:id/draft", async (c) => {
    const input = await body(c, saveConversationDraftSchema);
    return input.success
      ? respond(c, saveDraft(c.req.param("id"), input.data, deps))
      : c.json({ error: invalid }, 400);
  });
  app.patch("/conversations/:id/queue/:itemId", async (c) => {
    const input = await body(c, editableConversationContentSchema.refine(validTimelineAnchors));
    return input.success
      ? respond(c, editQueue(c.req.param("id"), c.req.param("itemId"), input.data, deps))
      : c.json({ error: invalid }, 400);
  });
  app.delete("/conversations/:id/queue/:itemId", (c) =>
    respond(c, cancelQueue(c.req.param("id"), c.req.param("itemId"), deps), 204),
  );
  app.put("/conversations/:id/answers", async (c) => {
    const input = await body(c, saveConversationAnswersSchema);
    return input.success
      ? respond(c, saveAnswers(c.req.param("id"), input.data, deps))
      : c.json({ error: invalid }, 400);
  });
  app.post("/conversations/:id/answers/send", async (c) => {
    const input = await body(c, sendConversationAnswersSchema);
    return input.success
      ? wire(c, await sendAnswers(c.req.param("id"), input.data, deps))
      : c.json({ error: invalid }, 400);
  });
  app.post("/conversations/:id/stop", async (c) => {
    const result = await deps.runner.call(
      "POST",
      `/conversations/${encodeURIComponent(c.req.param("id"))}/stop`,
    );
    if (result.isOk() && result.value.status === 409)
      return c.json({ error: { code: "conflict", message: "止める AI がありません" } }, 409);
    return result.isErr() || result.value.status >= 400
      ? wire(c, result)
      : c.json({ runState: "stopped" }, 202);
  });
  app.post("/conversations/:id/resume", async (c) =>
    wire(c, await resumeConversation(c.req.param("id"), deps)),
  );
  app.post("/conversations/:id/permissions/:requestId", async (c) => {
    const input = await body(c, permissionDecisionSchema);
    if (!input.success) return c.json({ error: invalid }, 400);
    const result = await deps.runner.call(
      "POST",
      `/conversations/${encodeURIComponent(c.req.param("id"))}/permissions/${encodeURIComponent(c.req.param("requestId"))}`,
      { behavior: input.data.decision },
    );
    return result.isErr() || result.value.status >= 400
      ? wire(c, result)
      : c.json({ runState: "working" }, 202);
  });
  app.post("/conversations/:id/images", async (c) =>
    respond(
      c,
      uploadImage(
        c.req.param("id"),
        c.req.header("content-type") ?? "",
        new Uint8Array(await c.req.arrayBuffer()),
        deps,
      ),
      201,
    ),
  );
  app.get("/conversations/:id/images/:imageId", (c) => {
    const image = readImage(c.req.param("id"), c.req.param("imageId"), deps);
    return image.isErr()
      ? respond(c, image)
      : new Response(image.value.data, {
          headers: {
            "content-type": image.value.mediaType,
            "cache-control": "private, max-age=31536000, immutable",
          },
        });
  });
  return app;
}
