import { releaseReservationSchema } from "../../../../shared/ipc";
import { err, ok } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { readFile } from "../../workspace/usecase/read-file";
import type { WorkspaceDependencies } from "../../workspace/domain/ports";
import type { RunnerLink } from "../../../runner-link";
import { runnerUnavailable } from "../../../runner-link";
import type { StockDependencies } from "../domain/ports";
import { createStockRepository } from "./stock-repository";
export function createStockDependencies(options: {
  database: () => OpenedDatabase["db"];
  workspace: WorkspaceDependencies;
  runner: () => Pick<RunnerLink, "forward">;
  changed: StockDependencies["changed"];
  id: () => string;
  now: () => number;
}): StockDependencies {
  return {
    repository: createStockRepository(options.database),
    readFile: (id, path) => readFile(id, path, options.workspace),
    release: async (id) => {
      const response = await options
        .runner()
        .forward("POST", `/conversations/${encodeURIComponent(id)}/release/reserve`);
      if (!response.ok)
        return response.status === 409
          ? err({
              code: "conflict",
              message: "スレッドの終了処理の状態が変わりました。もう一度操作してください",
            })
          : err(runnerUnavailable);
      const reservation = releaseReservationSchema.safeParse(
        await response.json().catch(() => undefined),
      );
      if (!reservation.success) return err(runnerUnavailable);
      return ok({
        token: reservation.data.token,
        complete: async () => {
          await options
            .runner()
            .forward("POST", `/conversations/${encodeURIComponent(id)}/release/complete`, {
              token: reservation.data.token,
            });
        },
      });
    },
    changed: options.changed,
    id: options.id,
    now: options.now,
  };
}
