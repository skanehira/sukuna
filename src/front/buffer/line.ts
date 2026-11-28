export type LineKind =
  | "heading"
  | "section"
  | "colhead"
  | "speaker"
  | "text"
  | "ask"
  | "tool"
  | "add"
  | "del"
  | "code"
  | "note"
  | "separator"
  | "menu"
  | "row"
  | "pair"
  | "queued"
  | "tree"
  | "skeleton";

export type OpenTarget = { url: string };

export type LineInfo = {
  kind: LineKind;
  text: string;
  cols?: string[];
  colDef?: string;
  id?: string;
  target?: OpenTarget;
  open?: () => void | Promise<void>;
  cursor?: true;
  action?: string;
  editLabel?: string;
  status?: string;
  main?: boolean;
  danger?: boolean;
  done?: boolean;
  mark?: string;
  progress?: number[];
  tone?: "wait" | "doing" | "done" | "muted";
  strong?: boolean;
  seq?: number;
  seqLine?: number;
  lineNumber?: number;
  designDiff?: { path: string; newNo?: number; row?: { side: "old" | "new"; line: number } };
  noQuote?: true;
};

export type ColumnDef = {
  name: string;
  widths: number[];
  heads?: string[];
  align?: ("left" | "right")[];
  wrap?: boolean[];
  classes?: string[];
};

export type ColumnSpan = { from: number; to: number };

const COLUMN_GAP = "  ";

export function columnSpans(line: LineInfo): ColumnSpan[] {
  const cols = line.cols;
  if (cols === undefined) return [];
  const spans: ColumnSpan[] = [];
  let from = 0;
  for (let index = 0; index < cols.length; index += 1) {
    const to = from + cols[index].length;
    spans.push({ from, to });
    from = to + COLUMN_GAP.length;
  }
  return spans;
}

export function isWhitespaceOnly(line: LineInfo): boolean {
  return line.kind !== "skeleton" && line.text.trim() === "";
}

export function columnWidth(
  widths: number[],
  index: number,
  share = widths.includes(0) ? 55 : 86,
): string | null {
  const width = widths[index];
  if (!width) return null;
  const total = widths.reduce((sum, value) => sum + value, 0);
  const ratio = (width / total) * share;
  return `min(${width}rem, ${ratio.toFixed(1)}cqw)`;
}
