import { err, ok, type Result } from "neverthrow";
import { objectOf } from "../../../../shared/activity/stage";
import type { ProgressResponse } from "../../../../shared/progress/schema";
import type { ProgressDependencies, ProgressError } from "../../conversation/domain/progress-port";
import { assembleProgress } from "../../conversation/usecase/conversation-progress";

export async function issueProgress(
  id: string,
  deps: ProgressDependencies,
): Promise<Result<ProgressResponse, ProgressError>> {
  const issue = deps.repository.findIssue(id);
  if (issue.isErr()) return err(issue.error);
  if (issue.value === null)
    return err({ code: "not_found", message: "issue が見つかりません。開き直してください。" });
  const events = deps.repository.issueEvents(id);
  if (events.isErr()) return err(events.error);
  let state = issue.value.state;
  if (state === "stopped") {
    const previous = events.value.findLast(
      (event) => event.type === "state_changed" && objectOf(event.payload).to !== "stopped",
    );
    const priorState = objectOf(previous?.payload).to;
    state = typeof priorState === "string" ? priorState : "stopped";
  }
  const kind =
    state === "triage"
      ? "triage"
      : ["design", "design_review"].includes(state)
        ? "design"
        : ["ready", "implementing", "done"].includes(state)
          ? "impl"
          : null;
  if (kind === null)
    return ok({ conversationId: null, activity: null, timeline: null, readError: null });
  const conversations = deps.repository.listIssueConversations(id);
  if (conversations.isErr()) return err(conversations.error);
  const conversation = conversations.value.find((item) => item.kind === kind);
  if (conversation === undefined)
    return ok({ conversationId: null, activity: null, timeline: null, readError: null });
  const conversationEvents = deps.repository.conversationEvents(conversation.id);
  if (conversationEvents.isErr()) return err(conversationEvents.error);
  const activeState = state === "design_review" ? "design" : state;
  return ok(
    await assembleProgress(conversation, conversationEvents.value, deps, {
      state: activeState,
      events: events.value,
    }),
  );
}
