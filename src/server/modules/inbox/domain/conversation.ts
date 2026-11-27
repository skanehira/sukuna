import { objectOf } from "../../../../shared/activity/stage";
import type { InboxConversation, InboxIssue, InboxProject } from "./ports";
import type { ConversationFacts } from "./section";
export function conversationFacts(c: InboxConversation): ConversationFacts {
  const lastEnd = c.events.findLast((e) => e.type === "turn_end");
  const turn = c.events.findLast((e) => e.type === "user_message");
  const origin = objectOf(turn?.payload).origin;
  return {
    runState: c.runState,
    stopReason: c.stopReason,
    closedAt: c.closedAt,
    unansweredQuestions: c.questions.length,
    pendingRecap:
      lastEnd !== undefined &&
      c.recapSeq < c.lastSeq &&
      (c.recapFailedAt === null || c.recapFailedAt < lastEnd.createdAt),
    developerTurn:
      typeof origin === "string" &&
      ["developer", "stock", "queued", "interrupt", "answer_text"].includes(origin),
  };
}
export function issueActiveState(issue: InboxIssue): string {
  if (issue.state !== "stopped") return issue.state;
  const stopped = issue.events.findLast(
    (e) =>
      e.type === "state_changed" &&
      objectOf(e.payload).to === "stopped" &&
      objectOf(e.payload).from !== "stopped",
  );
  const from = objectOf(stopped?.payload).from;
  return typeof from === "string" ? from : "stopped";
}
export function assignedConversation(
  issue: InboxIssue,
  project: InboxProject,
): InboxConversation | null {
  const state = issueActiveState(issue);
  const kind =
    state === "triage"
      ? "triage"
      : ["design", "design_review"].includes(state)
        ? "design"
        : ["ready", "implementing", "done"].includes(state)
          ? "impl"
          : null;
  return (
    project.conversations
      .filter((c) => c.issueId === issue.id && c.kind === kind)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0] ?? null
  );
}
export function unreadConversation(c: InboxConversation): boolean {
  return c.events.some((e) => e.seq > c.lastReadSeq && e.type !== "user_message");
}
export function childThreads(
  c: InboxConversation | null,
  project: InboxProject,
): InboxConversation[] {
  return c === null
    ? []
    : project.conversations.filter((t) => t.kind === "thread" && t.parentConversationId === c.id);
}
export function lastActivity(c: InboxConversation, project: InboxProject): number {
  return Math.max(
    c.lastActivityAt ?? 0,
    ...childThreads(c, project).map((t) => t.lastActivityAt ?? 0),
  );
}
export function issueLastActivity(issue: InboxIssue, project: InboxProject): number {
  const chats = project.conversations.filter((c) => c.issueId === issue.id);
  return Math.max(
    issue.createdAt,
    ...issue.events.map((e) => e.createdAt),
    ...chats.map((c) => lastActivity(c, project)),
  );
}
