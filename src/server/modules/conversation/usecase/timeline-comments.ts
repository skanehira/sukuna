import { objectOf, type ActivityEvent } from "../../../../shared/activity/stage";
import type { TimelineComment } from "../../../../shared/progress/schema";

export function buildTimelineComments(
  taskId: string,
  comments: readonly TimelineComment[],
  events: readonly ActivityEvent[],
): TimelineComment[] {
  const combined = comments.filter((comment) => comment.taskId === taskId);
  for (const event of events) {
    const payload = objectOf(event.payload);
    if (
      event.type !== "user_message" ||
      !["developer", "queued", "interrupt", "stock", "answer_text"].includes(
        String(payload.origin),
      ) ||
      typeof payload.text !== "string"
    )
      continue;
    const matches = [
      ...payload.text.matchAll(/^タイムラインのタスク ([^\s]+)「[^\n]*?」について: /gm),
    ];
    for (const [index, match] of matches.entries()) {
      if (match[1] !== taskId) continue;
      const text = payload.text
        .slice(match.index + match[0].length, matches[index + 1]?.index)
        .trimEnd();
      combined.push({ at: event.createdAt, taskId, text });
    }
  }
  const unique = new Map(
    combined.map((comment) => [JSON.stringify([comment.at, comment.text]), comment]),
  );
  return [...unique.values()].toSorted((a, b) => a.at - b.at);
}
