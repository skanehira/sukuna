import { ChangeSet, type ChangeDesc } from "@codemirror/state";
import type { TimelineAnchor } from "../../../shared/progress/draft";

export function consultationContent(text: string, taskId: string) {
  const timeline_anchors = [{ task_id: taskId, from: 0, bodyFrom: text.length, to: text.length }];
  return { text, images: [], timeline_anchors };
}

export function mapTimelineAnchors(
  anchors: readonly TimelineAnchor[],
  before: string,
  text: string,
  change?: ChangeDesc,
): TimelineAnchor[] {
  if (change?.empty || (change === undefined && before === text)) return [...anchors];
  const edits = change ?? replaceRange(before, text);
  const changed: { from: number; to: number; deleted: boolean }[] = [];
  edits.iterChangedRanges((from, to, newFrom, newTo) =>
    changed.push({ from, to, deleted: newFrom === newTo }),
  );
  const next: TimelineAnchor[] = [];
  let index = 0;
  for (const anchor of anchors) {
    while (index < changed.length && changed[index].to <= anchor.from) index++;
    const hit = changed[index];
    if ("originalText" in anchor) {
      if (hit?.deleted && hit.from <= anchor.from && hit.to >= anchor.to) continue;
      const from = edits.mapPos(anchor.from, 1);
      const insertedAtStart = edits.mapPos(anchor.from, -1);
      const startedInline =
        anchor.to > anchor.from && insertedAtStart < from && continuesLine(text, from);
      const end = edits.mapPos(anchor.to, -1);
      const extended = edits.mapPos(anchor.to, 1);
      const inline = anchor.to > anchor.from && extended > end && continuesLine(text, end);
      next.push({
        ...anchor,
        from: startedInline ? insertedAtStart : from,
        to: Math.max(from, inline ? extended : end),
      });
      continue;
    }
    if (hit && hit.from < anchor.bodyFrom) continue;
    next.push({
      task_id: anchor.task_id,
      from: edits.mapPos(anchor.from, 1),
      bodyFrom: edits.mapPos(anchor.bodyFrom, -1),
      to: edits.mapPos(anchor.to, 1),
    });
  }
  return next.map((anchor, index) => ({
    ...anchor,
    to: Math.min(anchor.to, next[index + 1]?.from ?? text.length),
  }));
}

export function continuesLine(text: string, at: number): boolean {
  return (
    at > 0 &&
    at < text.length &&
    text[at - 1] !== "\n" &&
    text[at] !== "\n" &&
    !(text[at] === "\r" && text[at + 1] === "\n")
  );
}

export function replaceRange(before: string, text: string): ChangeDesc {
  let from = 0;
  let to = before.length;
  let end = text.length;
  while (from < to && from < end && before[from] === text[from]) from++;
  while (to > from && end > from && before[to - 1] === text[end - 1]) {
    to--;
    end--;
  }
  return ChangeSet.of({ from, to, insert: text.slice(from, end) }, before.length, "\n");
}
