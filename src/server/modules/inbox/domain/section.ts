import type { RowPlacement } from "../../../../shared/inbox/schema";
import type { IssueState, IssueStopReason } from "../../../../shared/issue/state";
export type ConversationFacts = {
  runState: string;
  stopReason: string | null;
  closedAt: number | null;
  pendingRecap: boolean;
  unansweredQuestions: number;
  developerTurn: boolean;
};
export function threadNeedsDecision(c: ConversationFacts): boolean {
  return (
    c.closedAt === null &&
    (["waiting_answer", "waiting_permission", "failed", "usage_limited"].includes(c.runState) ||
      (c.runState === "stopped" && c.stopReason === "restarted"))
  );
}
export function conversationSection(
  c: ConversationFacts,
  threadDecision: boolean,
): RowPlacement | null {
  if (c.closedAt !== null) return null;
  if (threadDecision) return { section: "decision", reason: "thread" };
  switch (c.runState) {
    case "working":
      return { section: "working", reason: "working" };
    case "waiting_answer":
      return { section: "decision", reason: "question" };
    case "waiting_permission":
      return { section: "decision", reason: "permission" };
    case "failed":
      return { section: "decision", reason: "failed" };
    case "usage_limited":
      return { section: "decision", reason: "usage_limited" };
    case "idle":
      return c.pendingRecap
        ? { section: "working", reason: "summarizing" }
        : c.unansweredQuestions > 0
          ? { section: "decision", reason: "question" }
          : { section: "instruction", reason: "turn_ended" };
    case "stopped":
      return c.stopReason === "user"
        ? { section: "instruction", reason: "stopped_by_user" }
        : { section: "decision", reason: "restarted" };
    default:
      return null;
  }
}
export function issueSection(
  state: IssueState,
  stopReason: IssueStopReason | null,
  c: ConversationFacts | null,
  threadDecision: boolean,
): RowPlacement | null {
  if (state === "design_review") return { section: "decision", reason: "design_review" };
  if (state === "stopped" && stopReason !== null)
    return { section: "decision", reason: stopReason };
  let placement: RowPlacement | null = null;
  if (["triage", "design", "implementing"].includes(state)) {
    const own = c === null ? null : conversationSection({ ...c, closedAt: null }, false);
    if (c?.runState !== "idle" && own?.section === "decision" && own.reason !== "restarted")
      placement = own;
    else if (c?.runState === "idle")
      placement = c.pendingRecap
        ? { section: "working", reason: "summarizing" }
        : c.developerTurn
          ? { section: "instruction", reason: "turn_ended" }
          : { section: "working", reason: "flow_waiting" };
    else if (c?.runState === "working" || (c?.runState === "stopped" && c.stopReason === "user"))
      placement = own;
    else placement = { section: "working", reason: "flow_waiting" };
  }
  return threadDecision && placement?.section !== "decision"
    ? { section: "decision", reason: "thread" }
    : placement;
}
