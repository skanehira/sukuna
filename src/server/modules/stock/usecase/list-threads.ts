import { err } from "neverthrow";
import type { StockDependencies } from "../domain/ports";
export function listThreads(id: string, deps: StockDependencies) {
  const conversation = deps.repository.conversation(id);
  if (conversation.isErr()) return err(conversation.error);
  if (!conversation.value) return err({ code: "not_found" as const, message: "会話がありません" });
  return deps.repository.threads(id).map((threads) => ({ threads }));
}
