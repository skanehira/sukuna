import { err, ok, type Result } from "neverthrow";
import { lastActionInTurn } from "../../../../shared/activity/last-action";
import { resolveStage, type ActivityEvent } from "../../../../shared/activity/stage";
import type { ProgressResponse } from "../../../../shared/progress/schema";
import type {
  ProgressConversation,
  ProgressDependencies,
  ProgressError,
  ProgressEvent,
} from "../domain/progress-port";
import { replayTimeline } from "../domain/timeline/replay";
import { buildTimelineComments } from "./timeline-comments";

export async function conversationProgress(
  id: string,
  deps: ProgressDependencies,
): Promise<Result<ProgressResponse, ProgressError>> {
  const conversation = deps.repository.findConversation(id);
  if (conversation.isErr()) return err(conversation.error);
  if (conversation.value === null)
    return err({ code: "not_found", message: "会話が見つかりません。開き直してください。" });
  const events = deps.repository.conversationEvents(id);
  if (events.isErr()) return err(events.error);
  return ok(await assembleProgress(conversation.value, events.value, deps));
}

export async function assembleProgress(
  conversation: ProgressConversation,
  events: readonly ProgressEvent[],
  deps: ProgressDependencies,
  issue?: { state: string; events: readonly ActivityEvent[] },
): Promise<ProgressResponse> {
  const { turnStartedAt, ...action } = lastActionInTurn(events, conversation.cwd);
  const stage = resolveStage({
    issueState: issue?.state ?? null,
    events: issue?.events ?? [],
    turnStartedAt,
  });
  const read =
    conversation.sessionId === null
      ? { file: null, readError: null }
      : await deps.timeline.read(conversation.sessionId);
  const timeline = read.file === null ? null : replayTimeline(read.file);
  if (timeline !== null) {
    timeline.comments = buildTimelineComments(
      [...timeline.tasks, ...timeline.history.map(({ taskId, title }) => ({ id: taskId, title }))],
      timeline.comments,
      events,
    );
  }
  return {
    conversationId: conversation.id,
    activity: conversation.runState === "working" ? { ...stage, ...action } : null,
    timeline,
    readError: read.readError,
  };
}
