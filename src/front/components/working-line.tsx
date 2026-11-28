import { lastActionInTurn } from "../../shared/activity/last-action";
import { formatStageElapsed, STAGE_LABELS } from "../../shared/activity/stage";
import type { RunState } from "../../shared/events";
import type { ProgressResponse } from "../../shared/progress/schema";
import type { Event } from "../lib/conversation/types";

export function liveActivity(
  activity: ProgressResponse["activity"],
  events: readonly Event[],
  cwd: string,
  state: RunState,
): ProgressResponse["activity"] {
  if (state !== "working") return null;
  const action = lastActionInTurn(events, cwd);
  if (!activity)
    return {
      stage: "reply",
      stageLabel: STAGE_LABELS.reply,
      stageStartedAt: action.turnStartedAt,
      ...action,
    };
  const reply = activity.stage === "reply" && action.turnStartedAt > activity.stageStartedAt;
  return {
    ...activity,
    stageStartedAt: reply ? action.turnStartedAt : activity.stageStartedAt,
    ...(reply ||
    (action.lastActionAt !== null && action.lastActionAt >= (activity.lastActionAt ?? 0))
      ? { lastAction: action.lastAction, lastActionAt: action.lastActionAt }
      : {}),
  };
}

export function WorkingLine({
  activity,
  now,
}: {
  activity: ProgressResponse["activity"];
  now: () => number;
}) {
  if (!activity) return null;
  return (
    <>
      AI が作業中: {activity.stageLabel} {formatStageElapsed(activity.stageStartedAt, { now })} /
      最後にしたこと: {activity.lastAction}
    </>
  );
}
