import type { Quote, StockItem } from "../../../shared/stock";
import { matchesQuotedLine, sameDesignPosition, type QuoteSource } from "./quote";

type StockSymbol = "!" | "?" | "»" | "✓" | "→";
export type StockMark = { symbol: "›" } | { symbol: StockSymbol; item: StockItem };
const order = ["›", "!", "?", "»", "✓", "→"];
const compare = (left: { seq: number; line: number }, right: { seq: number; line: number }) =>
  left.seq - right.seq || left.line - right.line;

function markFor(item: StockItem): StockMark | undefined {
  if (item.state === "cancelled" || (item.quote.kind === "file" && item.stale)) return;
  if (item.state === "stocked") return { symbol: item.kind === "instruction" ? "!" : "?", item };
  if (item.kind === "instruction") return { symbol: "→", item };
  if (item.thread) return { symbol: item.thread.closed ? "✓" : "»", item };
}

function markedPositions(
  source: QuoteSource,
  lines: readonly string[],
  quote: Quote,
  firstOnly: boolean,
): number[] {
  if (source.kind === "conversation" && quote.kind === "conversation")
    return source.positions.flatMap((position, index) => {
      if (!position) return [];
      const from = compare(position, quote.start);
      return (firstOnly ? from === 0 : from >= 0 && compare(position, quote.end) <= 0)
        ? [index]
        : [];
    });

  if (source.kind === "file" && quote.kind === "file" && source.path === quote.path)
    return source.positions.flatMap((position, index) => {
      if (!position) return [];
      const line = position.line;
      return (
        firstOnly ? line === quote.start.line : line >= quote.start.line && line <= quote.end.line
      )
        ? [index]
        : [];
    });

  if (source.kind === "design_diff" && quote.kind === "design_diff" && source.path === quote.path) {
    const rows = source.positions.flatMap((position, index) =>
      position ? [{ ...position, index }] : [],
    );
    const selected = quote.text.split("\n");
    for (const [idx, row] of rows.entries()) {
      if (
        !sameDesignPosition(row, quote.start) ||
        !matchesQuotedLine(
          lines[row.index],
          selected[0],
          quote.start.col,
          quote.mode === "block" ? quote.end.col : undefined,
        )
      )
        continue;
      const end = idx + selected.length - 1;
      const finalRow = rows[end];
      if (!finalRow || !sameDesignPosition(finalRow, quote.end))
        return quote.start.row ? [] : [row.index];
      return firstOnly ? [row.index] : rows.slice(idx, end + 1).map(({ index }) => index);
    }
    return [];
  }

  if (source.kind === "pr_diff" && quote.kind === "pr_diff" && source.path === quote.path) {
    const sameStartSide = (position: NonNullable<(typeof source.positions)[number]>) =>
      !("side" in position) || ("side" in quote.start && quote.start.side === position.side);
    const sameEndSide = (position: NonNullable<(typeof source.positions)[number]>) =>
      !("side" in position) || ("side" in quote.end && quote.end.side === position.side);
    const first = quote.text.split("\n", 1)[0];
    const index = source.positions.findIndex(
      (position, line) =>
        position &&
        position.line === quote.start.line &&
        sameStartSide(position) &&
        (source.kind === "pr_diff" && quote.kind === "pr_diff" && source.commit === quote.commit
          ? matchesQuotedLine(
              lines[line],
              first,
              quote.start.col,
              quote.mode === "block" ? quote.end.col : undefined,
            )
          : lines[line].startsWith(first)),
    );
    if (index < 0) return [];
    if (firstOnly || (quote.start.line === quote.end.line && sameEndSide(source.positions[index]!)))
      return [index];
    const end = source.positions.findIndex(
      (position, line) =>
        line >= index && position?.line === quote.end.line && sameEndSide(position),
    );
    const hiddenEnd =
      end === -1 &&
      source.kind === "pr_diff" &&
      source.hidden?.some((position) => position.line === quote.end.line && sameEndSide(position));
    const visibleEnd = hiddenEnd ? source.positions.length - 1 : end;
    return source.positions.flatMap((position, line) =>
      position && line >= index && line <= visibleEnd ? [line] : [],
    );
  }
  return [];
}

export function stockMarks(
  source: QuoteSource,
  lines: readonly string[],
  items: readonly StockItem[],
  draft?: Quote,
): ReadonlyMap<number, StockMark> {
  const marks = new Map<number, StockMark>();
  if (draft)
    for (const position of markedPositions(source, lines, draft, false))
      marks.set(position, { symbol: "›" });

  const candidates = items.flatMap((item) => {
    const mark = markFor(item);
    return mark ? [{ item, mark }] : [];
  });
  candidates.sort(
    (left, right) =>
      order.indexOf(left.mark.symbol) - order.indexOf(right.mark.symbol) ||
      left.item.id.localeCompare(right.item.id),
  );
  for (const { item, mark } of candidates) {
    const firstOnly = mark.symbol !== "!" && mark.symbol !== "?";
    for (const position of markedPositions(source, lines, item.quote, firstOnly))
      if (!marks.has(position)) marks.set(position, mark);
  }
  return marks;
}
