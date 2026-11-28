import type {
  ConversationContent,
  ConversationQueueItem,
  QueueDeliveryContext,
} from "../../../../shared/conversation/api";
import { joinDraftContent, queueDraftContent } from "../../../../shared/progress/draft";

type Range = { from: number; to: number };

function locateGaps(text: string, gaps: string[], from: number, to: number): number[] | null {
  let cursor = from;
  const positions: number[] = [];
  for (const gap of gaps) {
    const offset = text.indexOf(gap, cursor);
    if (!gap || offset < 0 || offset + gap.length > to) return null;
    positions.push(offset);
    cursor = offset + gap.length;
  }
  cursor = to;
  for (let index = gaps.length - 1; index >= 0; index--) {
    const gap = gaps[index];
    const offset = text.lastIndexOf(gap, cursor - gap.length);
    if (offset < from || offset !== positions[index]) return null;
    cursor = offset;
  }
  return positions;
}

function restoreRanges(previous: string, next: string, source: Range[]): Range[] | null {
  if (!source.length) return next === previous ? [] : null;
  const head = previous.slice(0, source[0].from);
  const tail = previous.slice(source.at(-1)!.to);
  if (!next.startsWith(head) || !next.endsWith(tail)) return null;
  const end = next.length - tail.length;
  if (head.length > end) return null;
  const gaps = source
    .slice(0, -1)
    .map(({ to }, index) => previous.slice(to, source[index + 1].from));
  const positions = locateGaps(next, gaps, head.length, end);
  if (!positions) return null;
  return source.map((_, index) => ({
    from: index === 0 ? head.length : positions[index - 1] + gaps[index - 1].length,
    to: index === positions.length ? end : positions[index],
  }));
}

export function editDeliveryContext(
  previous: ConversationQueueItem,
  input: ConversationContent,
): { context?: QueueDeliveryContext } | null {
  const context = previous.deliveryContext;
  if (!context) return {};
  const originalText = context.original?.text ?? "";
  const source =
    context.originalRanges ??
    (originalText && previous.text.endsWith(originalText)
      ? [{ from: previous.text.length - originalText.length, to: previous.text.length }]
      : []);
  if (!source.length && originalText) return null;
  const ranges =
    input.text === previous.text ? source : restoreRanges(previous.text, input.text, source);
  if (!ranges) return null;
  const anchors =
    input.timeline_anchors ??
    (input.text === previous.text ? queueDraftContent(previous).timeline_anchors : undefined);
  const authored = ranges.reduce<ConversationContent>(
    (content, { from, to }) => {
      const local = anchors
        ?.filter((anchor) => anchor.from >= from && anchor.to <= to)
        .map((anchor) => ({
          ...anchor,
          from: anchor.from - from,
          to: anchor.to - from,
          ...("bodyFrom" in anchor ? { bodyFrom: anchor.bodyFrom - from } : {}),
        }));
      return joinDraftContent(content, {
        text: input.text.slice(from, to),
        images: [],
        ...(local === undefined ? {} : { timeline_anchors: local }),
      });
    },
    { text: "", images: input.images },
  );
  return {
    context: {
      ...context,
      original: authored.text || authored.images.length ? authored : undefined,
      originalRanges: ranges,
    },
  };
}
