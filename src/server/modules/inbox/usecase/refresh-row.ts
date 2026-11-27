import { lastActionInTurn, toolTarget } from "../../../../shared/activity/last-action";
import { resolveStage, objectOf } from "../../../../shared/activity/stage";
import type { InboxRow } from "../../../../shared/inbox/schema";
import type {
  InboxConversation,
  InboxDependencies,
  InboxIssue,
  InboxProject,
} from "../domain/ports";
import {
  assignedConversation,
  childThreads,
  conversationFacts,
  issueActiveState,
  issueLastActivity,
  lastActivity,
  unreadConversation,
} from "../domain/conversation";
import { conversationSection, issueSection, threadNeedsDecision } from "../domain/section";
import { statusText, type StatusContext } from "../domain/status-text";

export function refreshRow(
  project: InboxProject,
  target: InboxConversation | InboxIssue,
  deps: InboxDependencies,
  flowPaused: boolean,
): InboxRow | null {
  const issue = "state" in target ? target : null;
  const conversation =
    issue === null ? (target as InboxConversation) : assignedConversation(issue, project);
  const threads = childThreads(conversation, project);
  const attention = threads.find((t) => threadNeedsDecision(conversationFacts(t)));
  const placement =
    issue === null
      ? conversationSection(conversationFacts(target as InboxConversation), attention !== undefined)
      : issueSection(
          issue.state,
          issue.stopReason,
          conversation === null ? null : conversationFacts(conversation),
          attention !== undefined,
        );
  if (placement === null) return null;
  const threadAnswers = threads.filter(
    (t) => t.runState === "idle" && unreadConversation(t),
  ).length;
  const context = conversation === null ? {} : conversationStatus(conversation, deps);
  const stopped = issue?.events.findLast(
    (e) => e.type === "state_changed" && objectOf(e.payload).to === "stopped",
  );
  const stage =
    issue === null
      ? null
      : issue.state === "implementing"
        ? "impl"
        : issue.state === "triage"
          ? "triage"
          : "design";
  const text = statusText(placement.reason, {
    ...context,
    stopped: issue?.state === "stopped",
    ...(issue?.state === "stopped" ? { detail: stringOf(objectOf(stopped?.payload).detail) } : {}),
    threadAnswers,
    flowPaused: flowPaused || project.flowPaused,
    stageExcluded: stage !== null && !project.autoStages.includes(stage),
    thread:
      attention === undefined
        ? undefined
        : statusText(
            conversationSection(conversationFacts(attention), false)!.reason,
            conversationStatus(attention, deps),
          ),
  });
  let activity: InboxRow["activity"] = null;
  if (placement.reason === "working" && conversation !== null) {
    const { turnStartedAt, ...action } = lastActionInTurn(conversation.events, conversation.cwd);
    activity = {
      ...resolveStage({
        issueState: issue === null ? null : issueActiveState(issue),
        events: issue?.events ?? [],
        turnStartedAt,
      }),
      ...action,
    };
  }
  const id = target.id;
  const kind = issue === null ? "conversation" : "issue";
  return {
    key: `${kind}:${id}`,
    kind,
    id,
    project: { id: project.id, name: project.name },
    title:
      issue === null
        ? `会話: ${conversation?.title || "(題名なし)"}`
        : `#${issue.number} ${issue.title}`,
    ...placement,
    ...text,
    unread:
      placement.section !== "working" &&
      conversation !== null &&
      (unreadConversation(conversation) || threadAnswers > 0),
    priority: issue?.priority ?? null,
    lastActivityAt:
      issue === null
        ? lastActivity(target as InboxConversation, project)
        : issueLastActivity(issue, project),
    threadAnswers,
    activity,
    issue:
      issue === null
        ? null
        : { number: issue.number, state: issue.state, stopReason: issue.stopReason },
  };
}
function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function conversationStatus(c: InboxConversation, deps: InboxDependencies): StatusContext {
  const permission = objectOf(c.events.findLast((e) => e.type === "permission_request")?.payload);
  const stopped = objectOf(
    c.events.findLast((e) => e.type === "stopped" || e.type === "error")?.payload,
  );
  const tool = stringOf(permission.tool_name);
  const target = toolTarget(tool, permission.input, c.cwd);
  return {
    questions: c.questions,
    tool,
    target,
    detail: stringOf(stopped.detail) || stringOf(stopped.message),
    resetTime: c.resetsAt === null ? undefined : deps.resetTime(c.resetsAt),
    lastText: stringOf(
      objectOf(
        c.events.findLast(
          (e) => e.type === "assistant_text" && objectOf(e.payload).parent_tool_use_id == null,
        )?.payload,
      ).text,
    ),
  };
}
