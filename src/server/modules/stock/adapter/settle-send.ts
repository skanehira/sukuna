import { setTimeout } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { err, ok } from "neverthrow";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { conversations } from "../../../../shared/db/schema";
import { STOCK_SEND_SETTLEMENT_TIMEOUT_MS } from "../../../../shared/ipc";
import { stockSendReceipt } from "../../../../shared/stock-send-receipts";
import { runnerUnavailable } from "../../../runner-link";
import type { StockDependencies } from "../domain/ports";

type RetryClock = {
  now(): number;
  wait(delayMs: number): Promise<void>;
};
const systemClock: RetryClock = {
  now: () => performance.now(),
  wait: (delayMs) => setTimeout(delayMs),
};
const unresolved = {
  code: "internal" as const,
  message: "ストックの送信結果を確かめられませんでした。一覧を読み直してください。",
};

function sqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code === "SQLITE_BUSY" || error.code.startsWith("SQLITE_BUSY_"))
  );
}

function settle(
  { db, sqlite }: OpenedDatabase,
  id: string,
  attemptId: string,
  interrupted: boolean,
) {
  const timeout = sqlite.pragma("busy_timeout", { simple: true }) as number;
  sqlite.pragma("busy_timeout = 0");
  try {
    return db.transaction(
      (tx) => {
        const receipt = stockSendReceipt(tx, attemptId, id);
        const saved = receipt.settle(interrupted, (stockId) => ({
          stockId,
          ok: false,
          error: {
            code: "fork_failed",
            message: `スレッドを始められませんでした。${runnerUnavailable.message}`,
          },
        }));
        const closedAt = saved?.closedAt ?? null;
        const reopened =
          closedAt !== null &&
          tx
            .update(conversations)
            .set({ closedAt: null })
            .where(and(eq(conversations.id, id), eq(conversations.closedAt, closedAt)))
            .run().changes === 1;
        return { recovered: saved?.response ?? null, reopened };
      },
      { behavior: "immediate" },
    );
  } finally {
    sqlite.pragma(`busy_timeout = ${timeout}`);
  }
}

export function createStockSendSettlement(
  database: () => OpenedDatabase,
  clock: RetryClock = systemClock,
): StockDependencies["settleSend"] {
  return async (id, attemptId, interrupted) => {
    const deadline = clock.now() + STOCK_SEND_SETTLEMENT_TIMEOUT_MS;
    do {
      try {
        return ok(settle(database(), id, attemptId, interrupted));
      } catch (error) {
        if (!sqliteBusy(error)) return err(unresolved);
        const remaining = deadline - clock.now();
        if (remaining <= 0) return err(unresolved);
        await clock.wait(Math.min(50, remaining));
      }
    } while (clock.now() < deadline);
    return err(unresolved);
  };
}
