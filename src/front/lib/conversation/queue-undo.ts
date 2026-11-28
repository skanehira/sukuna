import { ChangeSet, type ChangeDesc } from "@codemirror/state";
import { queuedDraftContent } from "../../../shared/conversation/api";
import { joinDraftContent } from "../../../shared/progress/draft";
import { continuesLine, mapTimelineAnchors } from "./timeline-draft";
import type { Draft, DraftContent, QueueItem } from "./types";

export type CancelledDraft = {
  from: number;
  to: number;
  text: string;
  imageFrom: number;
  version: number;
  stored: Draft | null;
};

export function appendCancelledDraft(previous: DraftContent, item: QueueItem) {
  const content = joinDraftContent(previous, queuedDraftContent(item) ?? { text: "", images: [] });
  return {
    content,
    addition: {
      from: previous.text.length,
      to: content.text.length,
      text: content.text.slice(previous.text.length),
      imageFrom: previous.images.length,
    },
  };
}

export function mapCancelledDraft(
  added: CancelledDraft,
  edits: ChangeDesc,
  images: string[],
  item: QueueItem,
  version: number,
): CancelledDraft | null {
  let touched = false;
  edits.iterChangedRanges((from, to) => {
    if (from < added.to && to > added.from) touched = true;
  });
  if (touched || !matchesImages(added, images, item)) return null;
  const from = edits.mapPos(added.from, 1);
  return { ...added, from, to: Math.max(from, edits.mapPos(added.to, -1)), version };
}

export function ownsCancelledDraft(
  draft: DraftContent,
  added: CancelledDraft,
  item: QueueItem,
): boolean {
  return (
    draft.text.slice(added.from, added.to) === added.text &&
    !(
      added.text.length > 0 &&
      (continuesLine(draft.text, added.from) || continuesLine(draft.text, added.to))
    ) &&
    matchesImages(added, draft.images, item)
  );
}

export function removeCancelledDraft(
  draft: DraftContent,
  added: CancelledDraft,
  item: QueueItem,
): DraftContent | null {
  if (!ownsCancelledDraft(draft, added, item)) return null;

  const edits = ChangeSet.of({ from: added.from, to: added.to }, draft.text.length);
  const text = draft.text.slice(0, added.from) + draft.text.slice(added.to);
  let anchors = draft.timeline_anchors;
  const original = queuedDraftContent(item);
  if (!original?.text && original?.timeline_anchors?.length && anchors) {
    const index = anchors.findLastIndex(
      (anchor) => anchor.from === added.from && anchor.to === added.from,
    );
    if (index < 0) return null;
    anchors = anchors.filter((_, position) => position !== index);
  }
  return {
    text,
    images: [
      ...draft.images.slice(0, added.imageFrom),
      ...draft.images.slice(added.imageFrom + (original?.images.length ?? 0)),
    ],
    ...(anchors === undefined
      ? {}
      : { timeline_anchors: mapTimelineAnchors(anchors, draft.text, text, edits) }),
  };
}

function matchesImages(added: CancelledDraft, images: string[], item: QueueItem) {
  return (queuedDraftContent(item)?.images ?? []).every(
    (id, index) => images[added.imageFrom + index] === id,
  );
}
