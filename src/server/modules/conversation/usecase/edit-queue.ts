import {
  hasUnlocatedEdits,
  joinDraftContent,
  queueDraftContent,
  unlocatedConsultationNotice,
} from "../../../../shared/progress/draft";
import { err, ok } from "neverthrow";
import {
  queuedDraftContent,
  queuedStockIds,
  type ConversationContent,
  type ConversationQueueItem,
} from "../../../../shared/conversation/api";
import {
  missingConversation,
  type ConversationDependencies,
  type ConversationError,
} from "../domain/ports";
import { editDeliveryContext } from "./edit-delivery-context";
import { returnQueuedStock } from "../../stock/usecase/return-queued";
const needsConsultation: ConversationError = {
  code: "conflict",
  message: unlocatedConsultationNotice,
};
const protectedDeliveryText: ConversationError = {
  code: "conflict",
  message: "差し戻しの前置きとストックの引用を残し、本文を編集してください。",
};
const alreadyDelivered: ConversationError = { code: "not_found", message: "すでに届きました" };
export function editQueue(
  id: string,
  itemId: string,
  input: ConversationContent,
  deps: ConversationDependencies,
) {
  if (!deps.repository.conversation(id)) return err(missingConversation);
  const result = deps.repository.transaction(() => {
    const previous = deps.repository.queue(id).find(({ id }) => id === itemId);
    if (!previous) return err(alreadyDelivered);
    const next = queueEditContent(previous, input);
    if (!next || hasUnlocatedEdits(next)) return err(needsConsultation);
    const edited = editDeliveryContext(previous, next);
    if (!edited) return err(protectedDeliveryText);
    const item = deps.repository.editQueue(id, itemId, next, edited.context);
    return item ? ok({ queueItem: item }) : err(alreadyDelivered);
  });
  if (result.isOk()) deps.changed(id, ["queue"]);
  return result;
}

function queueEditContent(previous: ConversationQueueItem, input: ConversationContent) {
  if (input.timeline_anchors !== undefined || previous.text === input.text) return input;
  if (!previous.timeline_comments?.length && !previous.timeline_anchors?.length) return input;
  const anchors = queueDraftContent(previous).timeline_anchors;
  const [anchor] = anchors ?? [];
  if (
    anchors?.length !== 1 ||
    !anchor ||
    !("bodyFrom" in anchor) ||
    anchor.to !== previous.text.length ||
    !input.text.startsWith(previous.text.slice(0, anchor.bodyFrom))
  )
    return null;
  return { ...input, timeline_anchors: [{ ...anchor, to: input.text.length }] };
}
export function cancelQueue(id: string, itemId: string, deps: ConversationDependencies) {
  if (!deps.repository.conversation(id)) return err(missingConversation);
  const item = deps.repository.transaction(() => {
    const removed = deps.repository.removeQueue(id, itemId);
    if (!removed) return null;
    const stocks = queuedStockIds(removed);
    for (const stockId of stocks) returnQueuedStock(stockId, deps.repository);
    const addition = queuedDraftContent(removed);
    if (addition) {
      const draft = deps.repository.draft(id);
      deps.repository.writeDraft(id, {
        ...joinDraftContent(draft ?? { text: "", images: [] }, addition),
        updatedAt: deps.now(),
        updatedBy: draft?.updatedBy ?? removed.clientId ?? "",
      });
    }
    return { stocks, addition };
  });
  if (!item) return err(alreadyDelivered);
  const parts: ("queue" | "stock" | "draft")[] = ["queue"];
  if (item.stocks.length) parts.push("stock");
  if (item.addition) parts.push("draft");
  deps.changed(id, parts);
  return ok(undefined);
}
