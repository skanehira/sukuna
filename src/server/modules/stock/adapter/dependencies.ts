import { randomUUID } from "node:crypto";
import { z } from "zod";
import { stockSendResponseSchema } from "../../../../shared/stock";
import { releaseReservationSchema, threadProposalIpcResponseSchema } from "../../../../shared/ipc";
import { err, ok } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { readFile } from "../../workspace/usecase/read-file";
import type { WorkspaceDependencies } from "../../workspace/domain/ports";
import type { RunnerLink } from "../../../runner-link";
import { runnerUnavailable } from "../../../runner-link";
import type { StockDependencies, StockError } from "../domain/ports";
import { createStockRepository } from "./stock-repository";
import { createStockSendSettlement } from "./settle-send";
const ipcError = z.object({
  error: z.object({
    code: z.enum([
      "invalid_input",
      "not_found",
      "conflict",
      "internal",
      "runner_unavailable",
      "worktree_failed",
    ]),
    message: z.string(),
  }),
});

export function createStockDependencies(options: {
  database: () => OpenedDatabase;
  workspace: WorkspaceDependencies;
  runner: () => Pick<RunnerLink, "forward">;
  changed: StockDependencies["changed"];
  id: () => string;
  now: () => number;
}): StockDependencies {
  const forward = async <Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    input?: unknown,
  ) => {
    const response = await options.runner().forward("POST", path, input);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = ipcError.safeParse(body);
      return err<z.infer<Schema>, StockError>(
        parsed.success ? parsed.data.error : runnerUnavailable,
      );
    }
    const parsed = schema.safeParse(body);
    return parsed.success ? ok<z.infer<Schema>, StockError>(parsed.data) : err(runnerUnavailable);
  };
  return {
    repository: createStockRepository(() => options.database().db),
    readFile: (id, path) => readFile(id, path, options.workspace),
    stockSendAttempt: randomUUID,
    send: (id, input, attemptId) =>
      forward(`/conversations/${encodeURIComponent(id)}/stock/send`, stockSendResponseSchema, {
        ...input,
        attempt_id: attemptId,
      }),
    settleSend: createStockSendSettlement(options.database),
    propose: async (id) =>
      (
        await forward(
          `/conversations/${encodeURIComponent(id)}/finish/propose`,
          threadProposalIpcResponseSchema,
        )
      ).map(({ run_state }) => ({ runState: run_state })),
    release: async (id, idleOnly) => {
      const path = `/conversations/${encodeURIComponent(id)}/release/reserve`;
      const reservation = await forward(
        path,
        releaseReservationSchema,
        idleOnly ? { idle_only: true } : undefined,
      );
      if (reservation.isErr()) {
        if (reservation.error.code === "conflict" && !idleOnly)
          return err({
            code: "conflict",
            message: "スレッドの終了処理の状態が変わりました。もう一度操作してください",
          });
        return err(reservation.error.code === "internal" ? runnerUnavailable : reservation.error);
      }
      const { token } = reservation.value;
      return ok({
        token,
        complete: async () => {
          await options
            .runner()
            .forward("POST", `/conversations/${encodeURIComponent(id)}/release/complete`, {
              token,
            });
        },
      });
    },
    changed: options.changed,
    id: options.id,
    now: options.now,
  };
}
