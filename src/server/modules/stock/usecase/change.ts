import { err, ok } from "neverthrow";
import type { StockDependencies } from "../domain/ports";
import { stockConflict, transitionStock } from "../domain/stock-item";
import { present } from "./present";
export async function change(
  id: string,
  action: "edit" | "cancel" | "restore",
  text: string | undefined,
  deps: StockDependencies,
) {
  const current = deps.repository.get(id);
  if (current.isErr()) return err(current.error);
  if (!current.value) return err({ code: "not_found" as const, message: "質問・指示がありません" });
  const next = transitionStock(current.value.state, action);
  if (next.isErr()) return err(next.error);
  const updated = deps.repository.update(id, current.value.state, next.value, text);
  if (updated.isErr()) return err(updated.error);
  if (!updated.value) return err(stockConflict);
  deps.changed(updated.value.conversationId, ["stock"]);
  return ok({ item: await present(updated.value, deps) });
}
