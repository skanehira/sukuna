import { err, ok } from "neverthrow";
import type { StockDependencies } from "../domain/ports";
export async function finishThread(id: string, deps: StockDependencies) {
  const current = deps.repository.conversation(id);
  if (current.isErr()) return err(current.error);
  if (!current.value || current.value.kind !== "thread")
    return err({ code: "not_found" as const, message: "スレッドがありません" });
  const conflict = { code: "conflict" as const, message: "このスレッドはすでに終えています" };
  if (current.value.closedAt !== null) return err(conflict);
  const released = await deps.release(id);
  if (released.isErr()) return err(released.error);
  try {
    const closedAt = deps.now();
    const closed = deps.repository.close(id, closedAt, released.value.token);
    if (closed.isErr()) return err(closed.error);
    if (!closed.value)
      return err({
        code: "conflict" as const,
        message: "スレッドの終了処理の状態が変わりました。もう一度操作してください",
      });
    if (current.value.parentConversationId)
      deps.changed(current.value.parentConversationId, ["stock", "threads"]);
    deps.changed(id, ["threads"]);
    return ok({ thread: { id, closedAt } });
  } finally {
    await released.value.complete();
  }
}
