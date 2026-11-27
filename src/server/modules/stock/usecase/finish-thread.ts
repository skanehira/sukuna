import { err, ok } from "neverthrow";
import type { FinishThreadInput } from "../../../../shared/stock";
import type { StockDependencies } from "../domain/ports";
import { present } from "./present";

export async function finishThread(id: string, input: FinishThreadInput, deps: StockDependencies) {
  const current = deps.repository.conversation(id);
  if (current.isErr()) return err(current.error);
  if (!current.value || current.value.kind !== "thread")
    return err({ code: "not_found" as const, message: "スレッドがありません" });
  if (current.value.closedAt !== null)
    return err({ code: "conflict" as const, message: "このスレッドはすでに終えています" });

  if (input.action === "propose") return deps.propose(id);
  const released = await deps.release(id, input.action === "stock");
  if (released.isErr()) return err(released.error);
  try {
    const closedAt = deps.now();
    const token = released.value.token;
    const closed =
      input.action === "stock"
        ? deps.repository.finishTransaction((store) => {
            const source = store.sourceQuestion(id);
            if (!source || !store.close(id, closedAt, token)) return undefined;
            const item = store.addInstruction(
              deps.id(),
              source.conversationId,
              id,
              input.text,
              source.quote,
            );
            store.deleteDraft(id);
            return item;
          })
        : deps.repository.close(id, closedAt, token);
    if (closed.isErr()) return err(closed.error);
    if (!closed.value)
      return err({
        code: "conflict" as const,
        message: "スレッドの終了処理の状態が変わりました。もう一度操作してください",
      });
    if (current.value.parentConversationId)
      deps.changed(current.value.parentConversationId, ["stock", "threads"]);
    deps.changed(id, ["threads"]);
    if (typeof closed.value === "boolean") return ok({ thread: { id, closedAt } });
    return ok({ item: await present(closed.value, deps), thread: { id, closedAt } });
  } finally {
    await released.value.complete();
  }
}
