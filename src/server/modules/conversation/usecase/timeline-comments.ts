import {
  consultationBodySeparator,
  consultationMarker as marker,
} from "../../../../shared/progress/draft";
import { objectOf, type ActivityEvent } from "../../../../shared/activity/stage";
import {
  timelineInputCommentSchema,
  type TimelineComment,
  type UnresolvedTimelineComment,
} from "../../../../shared/progress/schema";

type ConsultationStart = { at: number; bodyAt: number; taskId: string };

function consultationInput(value: unknown) {
  const payload = objectOf(value);
  if (
    !["developer", "queued", "interrupt", "stock", "answer_text"].includes(
      String(payload.origin),
    ) ||
    typeof payload.text !== "string"
  )
    return { comments: [], texts: [] };
  if (!Array.isArray(payload.timeline_comments)) return { comments: [], texts: [payload.text] };
  return {
    comments: payload.timeline_comments.flatMap((value: unknown) => {
      const comment = timelineInputCommentSchema.safeParse(value);
      return comment.success ? [comment.data] : [];
    }),
    texts: Array.isArray(payload.timeline_legacy_texts)
      ? payload.timeline_legacy_texts.filter((text): text is string => typeof text === "string")
      : [],
  };
}

export function hasTimelineConsultation(payload: unknown): boolean {
  const { comments, texts } = consultationInput(payload);
  return (
    comments.length > 0 ||
    texts.some((text) => text.startsWith(marker) || text.includes("\n" + marker))
  );
}

export function buildTimelineComments(
  tasks: readonly { id: string; title: string }[],
  comments: readonly TimelineComment[],
  events: readonly ActivityEvent[],
): { comments: TimelineComment[]; unresolvedComments: UnresolvedTimelineComment[] } {
  const prefixes = [
    ...new Map(
      tasks.map(({ id, title }) => [
        JSON.stringify([id, title]),
        { prefix: `${marker}${id}「${title}${consultationBodySeparator}`, taskId: id },
      ]),
    ).values(),
  ];
  const combined = [...comments];
  const unresolvedComments: UnresolvedTimelineComment[] = [];
  for (const event of events) {
    if (event.type !== "user_message") continue;
    const { comments, texts } = consultationInput(event.payload);
    for (const comment of comments) {
      combined.push({ at: event.createdAt, taskId: comment.task_id, text: comment.text });
    }
    for (const text of texts) {
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
