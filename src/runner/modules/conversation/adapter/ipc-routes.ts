import { withConversationAdmission } from "../usecase/start";
import { Hono } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  allowMergeIpcSchema,
  answerSchema,
  completeReleaseSchema,
  forkConversationSchema,
  permissionSchema,
  reserveReleaseSchema,
  sendStockIpcSchema,
  type StockSendIpcInput,
  runnerCallerCancelled,
  sendMessageSchema,
  startConversationSchema,
  workspaceSchema,
} from "../../../../shared/ipc";
import type { RecapState } from "../../../../shared/recap/api";
import {
  proposeThreadFinish,
  threadFinishRefusal,
} from "../../stock/usecase/propose-thread-finish";
import type { StockSendResponse } from "../../../../shared/stock";
import { stopProject } from "../../flow/usecase/stop-project";
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
  rebuildRecap?: (id: string) => Result<{ state: RecapState }, OperationError>;
  sendStock?: (
    id: string,
    input: StockSendIpcInput,
    cancelled: () => boolean,
  ) => Promise<Result<StockSendResponse, DeliveryError>>;
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
      const result = await operation(
        c.req.param("id") ?? "",
        parsed.data,
        c.req.param(),
        runnerCallerCancelled(c.req.raw, () => runtime.options.clock.now()),
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
  route("/conversations", startConversationSchema, (_id, p, _params, callerCancelled) => {
    const input = {
      projectId: p.project_id,
      kind: p.kind,
      cwd: p.cwd,
      title: p.title,
      message: p.message,
      worktreeId: p.worktree_id,
      issueId: p.issue_id,
      parentConversationId: p.parent_conversation_id,
    };
    return input.kind === "thread" && input.parentConversationId
      ? withConversationAdmission(
          runtime,
          input.parentConversationId,
          "thread",
          callerCancelled,
          () => runtime.start({ ...input, callerCancelled }),
        )
      : runtime.start(input);
  });
  const sendStock = extensions.sendStock;
  if (sendStock)
    route("/conversations/:id/stock/send", sendStockIpcSchema, (id, input, _p, cancelled) =>
      sendStock(id, input, cancelled),
    );
  route("/conversations/:id/finish/propose", empty, (id, _p, _params, cancelled) =>
    proposeThreadFinish(runtime, id, cancelled),
  );
  route("/conversations/:id/messages", sendMessageSchema, async (id, p, _params, cancelled) => {
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
      undefined,
      cancelled,
    );
    return p.receipt_metadata ? result.map((value) => ({ ...value, duplicate })) : result;
  });
  route("/conversations/:id/queue/deliver", empty, (id, _p, _params, cancelled) =>
    runtime.deliverQueue(id, cancelled),
  );
  route("/conversations/:id/stop", empty, (id, _p, _params, cancelled) =>
    runtime.stop(id, undefined, undefined, cancelled),
  );
  route("/conversations/:id/resume", empty, (id, _p, _params, cancelled) =>
    runtime.resume(id, "developer", { callerCancelled: cancelled }),
  );
  route("/conversations/:id/fork", forkConversationSchema, (id, p, _params, callerCancelled) =>
    runtime.fork(id, p, callerCancelled),
  );
  route("/conversations/:id/answers", answerSchema, (id, p, _params, cancelled) =>
    runtime.answer(id, p.request_id, p.answers, cancelled),
  );
  route("/conversations/:id/permissions/:requestId", permissionSchema, (id, p, params, cancelled) =>
    runtime.permission(
      id,
      params.requestId ?? "",
      p.behavior === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: p.message ?? "" },
      cancelled,
    ),
  );
  route("/conversations/:id/release", empty, (id, _p, _params, cancelled) =>
    runtime.release(id, cancelled),
  );
  route(
    "/conversations/:id/release/reserve",
    reserveReleaseSchema,
    (id, input, _p, callerCancelled) =>
      runtime.releases.reserve(id, {
        callerCancelled,
        onlyIdle: input.only_idle,
        beforeRelease: input.idle_only ? () => threadFinishRefusal(runtime, id) : undefined,
      }),
  );
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
  const rebuildRecap = extensions.rebuildRecap;
  if (rebuildRecap)
    route("/conversations/:id/recap/rebuild", empty, (id) => Promise.resolve(rebuildRecap(id)));
  route("/flow/projects/:id/stop", empty, (id, _body, _params, callerCancelled) =>
    stopProject(runtime, id, callerCancelled),
  );
  if (extensions.flow) app.route("/flow", extensions.flow);
  app.get("/health", (c) => c.json(health));
  return app;
}
