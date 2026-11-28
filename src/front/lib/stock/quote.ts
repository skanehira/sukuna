import { codePointEdge, sliceStockBlockLine } from "../../../shared/stock-columns";
import type { DesignQuotePosition, Quote } from "../../../shared/stock";
import type { LineInfo } from "../../buffer/line";
import type { BufferSelection, SelectedRange } from "../../buffer/selection";

type Position = { line: number };
type ConversationPosition = Position & { seq: number };
export type PrPosition = Position & { side: "old" | "new" };
type Positions<T> = { positions: readonly (T | undefined)[] };
export type QuoteSource =
  | ({ kind: "conversation" } & Positions<ConversationPosition>)
  | ({ kind: "file"; path: string } & Positions<Position>)
  | ({ kind: "design_diff"; path: string } & Positions<Omit<DesignQuotePosition, "col">>)
  | ({
      kind: "pr_diff";
      path: string;
      commit: string;
      hidden?: readonly PrPosition[];
    } & Positions<PrPosition>)
  | { kind: "terminal" };

export function conversationSource(lines: readonly LineInfo[]): QuoteSource {
  return {
    kind: "conversation",
    positions: lines.map((line) =>
      line.seq !== undefined &&
      line.seqLine !== undefined &&
      line.noQuote !== true &&
      ["text", "tool", "add", "del", "code"].includes(line.kind)
        ? { seq: line.seq, line: line.seqLine }
        : undefined,
    ),
  };
}

export function fileSource(path: string, lines: readonly LineInfo[]): QuoteSource {
  return {
    kind: "file",
    path,
    positions: lines.map((line, index) => (line.kind === "code" ? { line: index + 1 } : undefined)),
  };
}

export function designSource(path: string, lines: readonly LineInfo[]): QuoteSource {
  return {
    kind: "design_diff",
    path,
    positions: lines.map(({ designDiff }) =>
      designDiff?.path === path && designDiff.newNo !== undefined
        ? { line: designDiff.newNo, ...(designDiff.row ? { row: designDiff.row } : {}) }
        : undefined,
    ),
  };
}

export function sameDesignPosition(
  current: Omit<DesignQuotePosition, "col">,
  saved: Omit<DesignQuotePosition, "col">,
): boolean {
  return (
    current.line === saved.line &&
    (!saved.row || (current.row?.side === saved.row.side && current.row.line === saved.row.line))
  );
}

export function matchesQuotedLine(
  text: string,
  firstLine: string,
  column: number,
  blockEnd?: number,
): boolean {
  return blockEnd === undefined
    ? text.startsWith(firstLine, column)
    : sliceStockBlockLine(text, column, blockEnd) === firstLine;
}

export function makeQuote(
  source: QuoteSource,
  lines: readonly string[],
  selection: BufferSelection,
): Quote | null {
  const mode = selection.mode;
  const ranges = selection.ranges.filter(
    ({ line }) =>
      lines[line] !== undefined &&
      (source.kind === "terminal" || source.positions[line] !== undefined),
  );
  if (!ranges.length) return null;
  const block =
    selection.block ??
    selection.ranges.reduce(
      (bounds, range) => ({
        from: Math.max(bounds.from, range.from),
        to: Math.max(bounds.to, range.to),
      }),
      { from: 0, to: 0 },
    );
  const coordinates = ({ line, from, to }: SelectedRange) => ({
    from: mode === "line" ? 0 : codePointEdge(lines[line], from, false),
    to: mode === "line" ? lines[line].length : codePointEdge(lines[line], to, true),
  });
  const text = ranges
    .map((range) => {
      const line = lines[range.line];
      if (mode === "block") return sliceStockBlockLine(line, block.from, block.to);
      const { from, to } = coordinates(range);
      return line.slice(from, to);
    })
    .join("\n");
  const base = { text, mode };
  if (source.kind === "terminal") return { ...base, kind: source.kind };

  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const start = { col: mode === "block" ? block.from : coordinates(first).from };
  const end = { col: mode === "block" ? block.to : coordinates(last).to };
  if (source.kind === "conversation")
    return {
      ...base,
      kind: source.kind,
      start: { ...source.positions[first.line]!, ...start },
      end: { ...source.positions[last.line]!, ...end },
    };
  if (source.kind === "pr_diff")
    return {
      ...base,
      kind: source.kind,
      path: source.path,
      commit: source.commit,
      start: { ...source.positions[first.line]!, ...start },
      end: { ...source.positions[last.line]!, ...end },
    };
  if (source.kind === "design_diff")
    return {
      ...base,
      kind: source.kind,
      path: source.path,
      start: { ...source.positions[first.line]!, ...start },
      end: { ...source.positions[last.line]!, ...end },
    };
  return {
    ...base,
    kind: source.kind,
    path: source.path,
    start: { ...source.positions[first.line]!, ...start },
    end: { ...source.positions[last.line]!, ...end },
  };
}
