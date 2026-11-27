import { designPrCreatedSchema } from "../../../../shared/api/design";
import type { StoredEvent } from "../../../../shared/events";
import type { FlowEvent } from "./evaluate";

export function designPrInput(pr: FlowEvent, messages: StoredEvent[]) {
  const parsed = designPrCreatedSchema.safeParse(pr.payload);
  if (!parsed.success) return undefined;
  const since = parsed.data.conversationSeq;
  return messages.findLast(
    (event) =>
      event.type === "user_message" &&
      (since === undefined ? event.createdAt > pr.createdAt : event.seq > since),
  );
}

export function designPrStarted(pr: FlowEvent, events: FlowEvent[], messages: StoredEvent[]) {
  return (
    Boolean(designPrInput(pr, messages)) ||
    events.some(
      (event) =>
        event.type === "ai_started" &&
        event.seq > pr.seq &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "kind" in event.payload &&
        event.payload.kind === "design",
    )
  );
}
