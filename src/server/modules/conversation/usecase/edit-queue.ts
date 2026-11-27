import { err, ok } from "neverthrow";
import type { ConversationContent } from "../../../../shared/conversation/api";
import {
  missingConversation,
  type ConversationDependencies,
  type ConversationError,
} from "../domain/ports";
import { returnQueuedStock } from "../../stock/usecase/return-queued";
const alreadyDelivered: ConversationError = { code: "not_found", message: "すでに届きました" };
export function editQueue(
  id: string,
  itemId: string,
  input: ConversationContent,
  deps: ConversationDependencies,
) {
  if (!deps.repository.conversation(id)) return err(missingConversation);
  const item = deps.repository.transaction(() => deps.repository.editQueue(id, itemId, input));
  if (!item) return err(alreadyDelivered);
  deps.changed(id, ["queue"]);
  return ok({ queueItem: item });
}
export function cancelQueue(id: string, itemId: string, deps: ConversationDependencies) {
  if (!deps.repository.conversation(id)) return err(missingConversation);
  const item = deps.repository.transaction(() => {
    const removed = deps.repository.removeQueue(id, itemId);
    if (!removed) return null;
    if (removed.stockItemId) returnQueuedStock(removed.stockItemId, deps.repository);
    else {
      const draft = deps.repository.draft(id);
      deps.repository.writeDraft(id, {
        text: [draft?.text ?? "", removed.text].filter(Boolean).join("\n\n"),
        images: [...(draft?.images ?? []), ...removed.images],
        updatedAt: deps.now(),
        updatedBy: draft?.updatedBy ?? removed.clientId ?? "",
      });
    }
    return removed;
  });
  if (!item) return err(alreadyDelivered);
  deps.changed(id, ["queue", item.stockItemId ? "stock" : "draft"]);
  return ok(undefined);
}
