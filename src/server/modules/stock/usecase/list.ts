import { err, ok } from "neverthrow";
import type { StockDependencies } from "../domain/ports";
import { present } from "./present";
export async function list(id: string, deps: StockDependencies) {
  const conversation = deps.repository.conversation(id);
  if (conversation.isErr()) return err(conversation.error);
  if (!conversation.value) return err({ code: "not_found" as const, message: "会話がありません" });
  const items = deps.repository.list(id);
  if (items.isErr()) return err(items.error);
  return ok({ items: await Promise.all(items.value.map((item) => present(item, deps))) });
}
