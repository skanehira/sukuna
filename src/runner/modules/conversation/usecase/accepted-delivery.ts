import {
  queuedStockIds,
  queuedDraftContent,
  type ConversationContent,
  type QueueDeliveryContext,
} from "../../../../shared/conversation/api";
import { joinDraftContent, queueDraftContent } from "../../../../shared/progress/draft";
import type { AcceptedInstruction, QueuedInstruction } from "../domain/conversation-store";
import type { SendInput } from "./runtime";

const emptyContent = (): ConversationContent => ({ text: "", images: [] });

export function inputContent(input: SendInput | QueuedInstruction): ConversationContent {
  return queueDraftContent({
    text: input.text,
    images: input.images,
    timeline_anchors: input.timelineAnchors,
    timeline_comments: input.timelineComments,
  });
}

export function queueReceipts(queued: readonly QueuedInstruction[]) {
  return queued.flatMap((item) => [
    ...(item.deliveryContext?.receipts ?? []),
    ...(item.clientId
      ? [{ clientId: item.clientId, queuedId: item.id, createdAt: item.createdAt }]
      : []),
  ]);
}

export function deliveryQueueIds(queued: readonly QueuedInstruction[]) {
  return [
    ...new Set(
      queued.flatMap(({ id, deliveryContext }) => [id, ...(deliveryContext?.queuedIds ?? [])]),
    ),
  ];
}

function originalRanges(
  queue: readonly QueuedInstruction[],
  input: SendInput,
  prefix: string,
  original?: ConversationContent,
) {
  const ranges: { from: number; to: number }[] = [];
  let text = prefix;
  for (const entry of [...queue, input]) {
    const separator = text && entry.text ? "\n\n" : "";
    const start = text.length + separator.length;
    text += separator + entry.text;
    const authored =
      "position" in entry
        ? (entry.deliveryContext?.original ??
          (entry.stockItemId || entry.deliveryContext ? undefined : entry))
        : original;
    const fragments =
      entry.deliveryContext?.originalRanges ??
      (authored && (authored.text || authored.images.length) && entry.text.endsWith(authored.text)
        ? [{ from: entry.text.length - authored.text.length, to: entry.text.length }]
        : []);
    for (const fragment of fragments) {
      const from = start + fragment.from;
      const to = start + fragment.to;
      const prior = ranges.at(-1);
      if (prior && (from === prior.to || text.slice(prior.to, from) === "\n\n")) prior.to = to;
      else ranges.push({ from, to });
    }
  }
  return ranges;
}

export function legacyDeliveryTexts(inputs: readonly (SendInput | QueuedInstruction)[]) {
  return inputs.flatMap(
    (input) =>
      input.deliveryContext?.legacyTexts ??
      (input.timelineComments === undefined && input.text ? [input.text] : []),
  );
}

export function deferredInstruction({
  id,
  conversationId,
  createdAt,
  input,
  queue,
  prefix,
  stockIds,
  original,
}: {
  id: string;
  conversationId: string;
  createdAt: number;
  input: SendInput;
  queue: QueuedInstruction[];
  prefix?: string;
  stockIds?: readonly string[];
  original?: ConversationContent;
}): AcceptedInstruction {
  const inputs = [...queue, input];
  const combined = inputs.reduce(
    (content, entry) => joinDraftContent(content, inputContent(entry)),
    { text: prefix ?? "", images: [] } as ConversationContent,
  );
  const sources = queue.reduce((content, item) => {
    const draft = queuedDraftContent({
      ...item,
      stockItemId: item.stockItemId ?? null,
      timeline_anchors: item.timelineAnchors,
      timeline_comments: item.timelineComments,
    });
    return draft ? joinDraftContent(content, draft) : content;
  }, emptyContent());
  const raw = original ? joinDraftContent(sources, original) : sources;
  const allStock = [
    ...new Set([...queue.flatMap((item) => [...queuedStockIds(item)]), ...(stockIds ?? [])]),
  ];
  const receipts = queueReceipts(queue);
  const queuedIds = deliveryQueueIds(queue);
  const ranges = originalRanges(queue, input, prefix ?? "", original);
  const structured = inputs.some((entry) => entry.timelineComments !== undefined);
  const context: QueueDeliveryContext = {
    ...(allStock.length ? { stockIds: allStock } : {}),
    ...(raw.text || raw.images.length ? { original: raw } : {}),
    ...(receipts.length ? { receipts } : {}),
    ...(queuedIds.length ? { queuedIds } : {}),
    ...(ranges.length ? { originalRanges: ranges } : {}),
    ...(structured ? { legacyTexts: legacyDeliveryTexts(inputs) } : {}),
  };
  return {
    id,
    conversationId,
    text: combined.text,
    images: combined.images,
    clientId: input.clientId ?? null,
    createdAt,
    deliveryContext: context,
    ...(combined.timeline_anchors === undefined
      ? {}
      : { timelineAnchors: combined.timeline_anchors }),
    ...(structured
      ? { timelineComments: inputs.flatMap((entry) => entry.timelineComments ?? []) }
      : {}),
  };
}
