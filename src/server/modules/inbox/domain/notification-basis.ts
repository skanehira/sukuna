import { objectOf } from "../../../../shared/activity/stage";
import type { InboxRow } from "../../../../shared/inbox/schema";
import { conversationFacts } from "./conversation";
import { isWaiting } from "./notification";
import type { InboxConversation, InboxIssue } from "./ports";
import { conversationSection, issueSection } from "./section";

function conversationBasis(conversation: InboxConversation, reason: InboxRow["reason"]) {
  const event = conversation.events.findLast((item) => {
    switch (reason) {
      case "question":
        return item.type === (conversation.runState === "waiting_answer" ? "question" : "turn_end");
      case "permission":
        return item.type === "permission_request";
      case "turn_ended":
        return item.type === "turn_end";
      case "usage_limited":
      case "usage_limit":
        return item.type === "stopped" && objectOf(item.payload).reason === "usage_limit";
      case "restarted":
        return item.type === "stopped" && objectOf(item.payload).reason === "restarted";
      case "failed":
        return (
          item.type === "error" ||
          (item.type === "stopped" &&
            !["user", "restarted", "usage_limit"].includes(String(objectOf(item.payload).reason)))
        );
      default:
        return false;
    }
  });
  const at = event?.createdAt ?? conversation.lastActivityAt ?? 0;
  return {
    at,
    marker: JSON.stringify([rowReason(reason), conversation.id, event?.seq ?? null, at]),
  };
}

function rowReason(reason: InboxRow["reason"]): InboxRow["reason"] {
  return reason === "usage_limit" ? "usage_limited" : reason;
}

export function notificationBasis(
  row: InboxRow,
  target: InboxConversation | InboxIssue,
  assigned: InboxConversation | undefined,
) {
  let own: Pick<InboxRow, "section" | "reason"> | null = row;
  if (row.reason === "thread")
    own =
      "state" in target
        ? issueSection(
            target.state,
            target.stopReason,
            assigned ? conversationFacts(assigned) : null,
            false,
          )
        : conversationSection(conversationFacts(target), false);
  if (!own || !isWaiting(own.section)) return null;
  const { reason } = own;
  if (!("state" in target)) return conversationBasis(target, reason);
  if (
    assigned &&
    (reason === "permission" ||
      (reason === "question" &&
        (assigned.runState === "waiting_answer" ||
          (assigned.runState === "idle" && assigned.questions.length > 0))) ||
      (reason === "failed" && assigned.runState === "failed") ||
      (rowReason(reason) === "usage_limited" && assigned.runState === "usage_limited") ||
      reason === "turn_ended")
  )
    return conversationBasis(assigned, reason);

  const event = target.events.findLast((item) => {
    if (item.type !== "state_changed") return false;
    const payload = objectOf(item.payload);
    return payload.to === undefined || (payload.to === target.state && payload.from !== payload.to);
  });
  const at = event?.createdAt ?? target.createdAt;
  return { at, marker: JSON.stringify([reason, target.id, event?.seq ?? null, at]) };
}
