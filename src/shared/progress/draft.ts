import { z } from "zod";
import { timelineInputCommentSchema, type TimelineInputComment } from "./schema";

export const consultationMarker = "タイムラインのタスク ";
export const consultationBodySeparator = "」について: ";
export const unlocatedConsultationNotice =
  "以前の相談の本文の位置が分かりません。元の文を残すか、前置きと本文を消してタスクの詳細から相談先を選び直してください。";

const position = z.number().int().nonnegative();
const locatedAnchorSchema = z.strictObject({
  task_id: z.string(),
  from: position,
  bodyFrom: position,
  to: position,
});
const unlocatedAnchorSchema = z.strictObject({
  from: position,
  to: position,
  originalText: z.string(),
  comments: z.array(timelineInputCommentSchema).min(1),
});
export const timelineAnchorSchema = z.union([locatedAnchorSchema, unlocatedAnchorSchema]);
export type TimelineAnchor = z.infer<typeof timelineAnchorSchema>;

type AnchoredText = { text: string; timeline_anchors?: TimelineAnchor[] };
type DraftContent = AnchoredText & { images: string[] };

export function validTimelineAnchors(input: AnchoredText): boolean {
  let end = 0;
  for (const anchor of input.timeline_anchors ?? []) {
    if (
      anchor.from < end ||
      anchor.to < anchor.from ||
      anchor.to > input.text.length ||
      ("bodyFrom" in anchor && (anchor.bodyFrom <= anchor.from || anchor.to < anchor.bodyFrom))
    )
      return false;
    end = anchor.to;
  }
  return true;
}

export function hasUnlocatedEdits(input: AnchoredText): boolean {
  return (input.timeline_anchors ?? []).some(
    (anchor) =>
      "originalText" in anchor && input.text.slice(anchor.from, anchor.to) !== anchor.originalText,
  );
}

export function commentsFromAnchors(
  text: string,
  anchors: readonly TimelineAnchor[],
): TimelineInputComment[] {
  return anchors.flatMap((anchor) =>
    "comments" in anchor
      ? anchor.comments
      : [{ task_id: anchor.task_id, text: text.slice(anchor.bodyFrom, anchor.to) }],
  );
}

export function queueDraftContent(
  item: DraftContent & { timeline_comments?: TimelineInputComment[] },
): DraftContent {
  const { text, images, timeline_comments: comments } = item;
  if (item.timeline_anchors !== undefined)
    return { text, images, timeline_anchors: item.timeline_anchors };
  if (comments === undefined) return { text, images };
  if (comments.length === 0) return { text, images, timeline_anchors: [] };

  const [comment] = comments;
  const prefixStart = `${consultationMarker}${comment.task_id}「`.replace(/\r\n?/g, "\n");
  const bodyFrom = text.length - comment.text.length;
  const title = text.slice(prefixStart.length, bodyFrom - consultationBodySeparator.length);
  if (
    comments.length === 1 &&
    text.startsWith(prefixStart) &&
    text.endsWith(consultationBodySeparator + comment.text) &&
    bodyFrom >= prefixStart.length + consultationBodySeparator.length &&
    !title.includes(consultationBodySeparator) &&
    !title.includes("\n" + consultationMarker)
  ) {
    return {
      text,
      images,
      timeline_anchors: [{ task_id: comment.task_id, from: 0, bodyFrom, to: text.length }],
    };
  }
  return {
    text,
    images,
    timeline_anchors: [{ from: 0, to: text.length, originalText: text, comments }],
  };
}

export function joinDraftContent(previous: DraftContent, next: DraftContent): DraftContent {
  const separator = previous.text && next.text ? "\n\n" : "";
  const offset = previous.text.length + separator.length;
  const shifted = next.timeline_anchors?.map((anchor) => ({
    ...anchor,
    from: anchor.from + offset,
    to: anchor.to + offset,
    ...("bodyFrom" in anchor ? { bodyFrom: anchor.bodyFrom + offset } : {}),
  }));
  const anchored = previous.timeline_anchors !== undefined || shifted !== undefined;
  return {
    text: previous.text + separator + next.text,
    images: [...previous.images, ...next.images],
    ...(anchored
      ? { timeline_anchors: [...(previous.timeline_anchors ?? []), ...(shifted ?? [])] }
      : {}),
  };
}
