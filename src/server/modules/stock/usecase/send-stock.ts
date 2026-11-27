import { err, ok } from "neverthrow";
import type { StockSendInput } from "../../../../shared/stock";
import type { StockDependencies } from "../domain/ports";

export async function sendStock(id: string, input: StockSendInput, deps: StockDependencies) {
  const attempt = deps.stockSendAttempt();
  const result = await deps.send(id, input, attempt);
  if (
    result.isErr() &&
    result.error.code !== "runner_unavailable" &&
    result.error.code !== "internal"
  )
    return result;

  const reconciled = await deps.settleSend(id, attempt, result.isErr());
  if (reconciled.isErr()) return err(reconciled.error);
  const { recovered, reopened } = reconciled.value;
  if (reopened) deps.changed(id, []);
  return result.isErr() && recovered ? ok(recovered) : result;
}
