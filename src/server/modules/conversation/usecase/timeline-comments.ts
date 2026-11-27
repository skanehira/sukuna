import { objectOf, type ActivityEvent } from "../../../../shared/activity/stage";
import {
  timelineInputCommentSchema,
  type TimelineComment,
  type UnresolvedTimelineComment,
} from "../../../../shared/progress/schema";

const marker = "タイムラインのタスク ";
type ConsultationStart = { at: number; bodyAt: number; taskId: string };

export function buildTimelineComments(
  tasks: readonly { id: string; title: string }[],
  comments: readonly TimelineComment[],
  events: readonly ActivityEvent[],
): { comments: TimelineComment[]; unresolvedComments: UnresolvedTimelineComment[] } {
  const prefixes = [
    ...new Map(
      tasks.map(({ id, title }) => [
        JSON.stringify([id, title]),
        { prefix: `${marker}${id}「${title}」について: `, taskId: id },
      ]),
    ).values(),
  ];
  const combined = [...comments];
  const unresolvedComments: UnresolvedTimelineComment[] = [];
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
    const structured = payload.timeline_comments;
    if (Array.isArray(structured)) {
      for (const comment of structured) {
        const parsed = timelineInputCommentSchema.safeParse(comment);
        if (parsed.success)
          combined.push({
            at: event.createdAt,
            taskId: parsed.data.task_id,
            text: parsed.data.text,
          });
      }
    }
    const texts = Array.isArray(structured)
      ? Array.isArray(payload.timeline_legacy_texts)
        ? payload.timeline_legacy_texts
        : []
      : [payload.text];
    for (const text of texts) {
      if (typeof text !== "string") continue;
      const starts: ConsultationStart[] = [];
      let reason: UnresolvedTimelineComment["reason"] | undefined;
      let cursor = 0;
      while (cursor < text.length) {
        const at = text.indexOf(marker, cursor);
        if (at === -1) break;
        cursor = at + marker.length;
        if (at > 0 && text[at - 1] !== "\n") continue;
        const matches = prefixes.filter(({ prefix }) => text.startsWith(prefix, at));
        const match = matches[0];
        if (match === undefined) continue;
        if (
          new Set(matches.map(({ prefix }) => prefix.length)).size > 1 ||
          starts.some((start) => start.bodyAt > at)
        )
          reason = "ambiguous_boundary";
        else if (new Set(matches.map(({ taskId }) => taskId)).size > 1) reason ??= "ambiguous_task";
        const bodyAt = at + match.prefix.length;
        starts.push({ at, bodyAt, taskId: match.taskId });
      }
      if (reason !== undefined) {
        unresolvedComments.push({ at: event.createdAt, text, reason });
        continue;
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
  }
  const unique = new Map(
    combined.map((comment) => [
      JSON.stringify([comment.taskId, comment.at, comment.text]),
      comment,
    ]),
  );
  return {
    comments: [...unique.values()].toSorted((a, b) => a.at - b.at),
    unresolvedComments: [
      ...new Map(unresolvedComments.map((comment) => [JSON.stringify(comment), comment])).values(),
    ].toSorted((a, b) => a.at - b.at),
  };
}
