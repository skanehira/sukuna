import { Hono } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  allowMergeIpcSchema,
  answerSchema,
  completeReleaseSchema,
  forkConversationSchema,
  permissionSchema,
  RUNNER_IPC_DEADLINE_HEADER,
  sendMessageSchema,
  startConversationSchema,
  workspaceSchema,
} from "../../../../shared/ipc";
import type { Logger } from "../../../../shared/log";
import type { ConversationRuntime, DeliveryError, OperationError } from "../usecase/runtime";

function wireResult(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      v,
    ]),
  );
}
export type IpcExtensions = {
  flow?: Hono;
  allowMerge?: (
    id: string,
    headSha: string,
  ) => Promise<Result<{ state: "implementing" }, OperationError>>;
  workspace?: (
    id: string,
    input: z.infer<typeof workspaceSchema>,
    cancelled: () => boolean,
  ) => Promise<Result<{ cwd: string }, OperationError>>;
};
export function createIpcRoutes(
  runtime: ConversationRuntime,
  log: Logger,
  health = { pid: process.pid, started_at: Date.now(), version: "0.0.0" },
  extensions: IpcExtensions = {},
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    log({ level: "info", component: "runner.ipc", message: `${c.req.method} ${c.req.path}` });
    if (runtime.closing) {
      log({ level: "info", component: "runner.ipc", message: "操作結果: 503" });
      return c.json(
        {
          error: {
            code: "runner_unavailable",
            message:
              "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
          },
        },
        503,
      );
    }
    await next();
    log({ level: "info", component: "runner.ipc", message: `操作結果: ${c.res.status}` });
  });
  app.onError((error, c) => {
    log({ level: "error", component: "runner.ipc", message: "会話の操作に失敗しました。", error });
    return c.json(
      {
        error: {
          code: "internal",
          message: "会話の操作に失敗しました。もう一度操作してください。",
        },
      },
      500,
    );
  });
  const route = <S extends z.ZodType>(
    path: string,
    schema: S,
    operation: (
      id: string,
      input: z.infer<S>,
      params: Record<string, string>,
      callerCancelled: () => boolean,
    ) => Promise<Result<unknown, DeliveryError>>,
  ) => {
    app.post(path, async (c) => {
      const body = await c.req.json().catch(() => undefined);
      const parsed = schema.safeParse(body);
      if (!parsed.success)
        return c.json(
          { error: { code: "invalid_input", message: "入力を確認してください。" } },
          400,
        );
      const deadline = Number(c.req.header(RUNNER_IPC_DEADLINE_HEADER) ?? NaN);
      const signal = c.req.raw.signal;
      const callerCancelled = () =>
        signal.aborted ||
        (Number.isSafeInteger(deadline) && runtime.options.clock.now() >= deadline);
      const result = await operation(
        c.req.param("id") ?? "",
        parsed.data,
        c.req.param(),
        callerCancelled,
      );
      return result.isErr()
        ? c.json(
            { error: result.error },
            result.error.code === "conflict"
              ? 409
              : result.error.code === "not_found"
                ? 404
                : result.error.code === "invalid_input"
                  ? 400
                  : result.error.code === "runner_unavailable"
                    ? 503
                    : 500,
          )
        : c.json(wireResult(result.value));
    });
  };
  const empty = z.preprocess((input) => (input === undefined ? {} : input), z.object({}));
  route("/conversations", startConversationSchema, (_id, p) =>
    runtime.start({
      projectId: p.project_id,
      kind: p.kind,
      cwd: p.cwd,
      title: p.title,
      message: p.message,
      worktreeId: p.worktree_id,
      issueId: p.issue_id,
      parentConversationId: p.parent_conversation_id,
    }),
  );
  route("/conversations/:id/messages", sendMessageSchema, async (id, p) => {
    let duplicate = false;
    const result = await runtime.send(
      id,
      {
        text: p.text,
        images: p.images,
        interrupt: p.interrupt,
        clientId: p.client_id,
        origin: p.origin,
        timelineComments: p.timeline_comments,
      },
      (fresh) => {
        duplicate = !fresh;
      },
    );
    return p.receipt_metadata ? result.map((value) => ({ ...value, duplicate })) : result;
  });
  route("/conversations/:id/queue/deliver", empty, (id) => runtime.deliverQueue(id));
  route("/conversations/:id/stop", empty, (id) => runtime.stop(id));
  route("/conversations/:id/resume", empty, (id, _p, _params, callerCancelled) =>
    runtime.resume(id, "developer", { callerCancelled }),
  );
  route("/conversations/:id/fork", forkConversationSchema, (id, p) => runtime.fork(id, p));
  route("/conversations/:id/answers", answerSchema, (id, p) =>
    runtime.answer(id, p.request_id, p.answers),
  );
  route("/conversations/:id/permissions/:requestId", permissionSchema, (id, p, params) =>
    runtime.permission(
      id,
      params.requestId ?? "",
      p.behavior === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: p.message ?? "" },
    ),
  );
  route("/conversations/:id/release", empty, (id) => runtime.release(id));
  route("/conversations/:id/release/reserve", empty, (id) => runtime.releases.reserve(id));
  route("/conversations/:id/release/complete", completeReleaseSchema, (id, p) =>
    Promise.resolve(runtime.releases.complete(id, p.token).map(() => ({}))),
  );
  app.get("/conversations/:id/commands", async (c) =>
    c.json({
      commands: await runtime.commands(c.req.param("id")),
    }),
  );
  const workspace = extensions.workspace;
  if (workspace)
    route("/conversations/:id/workspace", workspaceSchema, (id, p, _params, callerCancelled) =>
      workspace(id, p, callerCancelled),
    );
  if (extensions.allowMerge) {
    const allowMerge = extensions.allowMerge;
    route("/flow/issues/:id/pr/allow-merge", allowMergeIpcSchema, (id, p) =>
      allowMerge(id, p.head_sha),
    );
  }
  if (extensions.flow) app.route("/flow", extensions.flow);
  app.get("/health", (c) => c.json(health));
  return app;
}
