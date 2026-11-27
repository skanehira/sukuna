import { objectOf, type ActivityEvent } from "../../../../shared/activity/stage";
import type { TimelineComment } from "../../../../shared/progress/schema";

const marker = "タイムラインのタスク ";
type ConsultationStart = { at: number; bodyAt: number; taskId: string };

export function buildTimelineComments(
  tasks: readonly { id: string; title: string }[],
  comments: readonly TimelineComment[],
  events: readonly ActivityEvent[],
): TimelineComment[] {
  const prefixes = [
    ...new Map(
      tasks.map(({ id, title }) => [`${marker}${id}「${title}」について: `, id]),
    ).entries(),
  ]
    .map(([prefix, taskId]) => ({ prefix, taskId }))
    .toSorted((a, b) => b.prefix.length - a.prefix.length);
  const combined = [...comments];
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
    const text = payload.text;
    const starts: ConsultationStart[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      const at = text.indexOf(marker, cursor);
      if (at === -1) break;
      cursor = at + marker.length;
      if (at > 0 && text[at - 1] !== "\n") continue;
      const match = prefixes.find(({ prefix }) => text.startsWith(prefix, at));
      if (match === undefined) continue;
      const bodyAt = at + match.prefix.length;
      starts.push({ at, bodyAt, taskId: match.taskId });
      cursor = bodyAt;
    }
    for (const [index, start] of starts.entries()) {
      const end = starts[index + 1]?.at;
      const body = text.slice(start.bodyAt, end);
      combined.push({
        at: event.createdAt,
        taskId: start.taskId,
        text: end === undefined ? body : body.replace(/\r?\n(?:\r?\n)?$/, ""),
      });
    }
  }
  const unique = new Map(
    combined.map((comment) => [
      JSON.stringify([comment.taskId, comment.at, comment.text]),
      comment,
    ]),
  );
  return [...unique.values()].toSorted((a, b) => a.at - b.at);
}
