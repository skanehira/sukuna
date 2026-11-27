import { designEvents, type DesignEvent, type DesignStatus } from "../../../../shared/api/design";
import type { IssueState } from "../../../../shared/issue/state";
import { objectOf } from "../../../../shared/activity/stage";

export type { DesignEvent } from "../../../../shared/api/design";

export function designStatus(state: IssueState, events: DesignEvent[]): DesignStatus {
  const history = designEvents(events);
  if (!history.submission) return "none";
  if (history.reflected) return "approved";
  if (state === "stopped") {
    const stopped = events
      .filter((event) => event.type === "state_changed" && objectOf(event.payload).to === "stopped")
      .sort((a, b) => b.seq - a.seq);
    if (objectOf(stopped[0]?.payload).cause === "design_pr_not_merged") return "merge_failed";
    const priorState = objectOf(
      stopped.find((event) => objectOf(event.payload).from !== "stopped")?.payload,
    ).from;
    if (priorState === "design_review") state = "design_review";
    if (priorState === "design") state = "design";
  }
  if (history.pr && !history.failure) return "merging_pr";
  if (history.reflecting) return "reflecting";
  return state === "design_review" ? "reviewing" : "designing";
}
