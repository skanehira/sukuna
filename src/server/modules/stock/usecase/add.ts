import { err, ok } from "neverthrow";
import type { AddStockInput } from "../../../../shared/stock";
import type { StockDependencies } from "../domain/ports";
import { present } from "./present";
export async function add(id: string, input: AddStockInput, deps: StockDependencies) {
  const conversation = deps.repository.conversation(id);
  if (conversation.isErr()) return err(conversation.error);
  if (!conversation.value) return err({ code: "not_found" as const, message: "会話がありません" });
  if (conversation.value.kind === "thread")
    return err({ code: "conflict" as const, message: "スレッドでは、i で直接返信します" });
  const item = deps.repository.add(deps.id(), id, input);
  if (item.isErr()) return err(item.error);
  deps.changed(id, ["stock"]);
  return ok({ item: await present(item.value, deps) });
}
