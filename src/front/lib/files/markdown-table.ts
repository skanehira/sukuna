import { StateEffect, type Range, type Text } from "@codemirror/state";
import { Decoration, type EditorView, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { parser } from "@lezer/markdown";

type SyntaxNode = ReturnType<typeof parser.parse>["topNode"];
export type Font = { bold: boolean; mono: boolean };
export type TextWidth = (text: string, font: Font) => number;

type Align = "left" | "center" | "right" | undefined;
type Cell = { node: SyntaxNode; column: number };
type Row = { line: number; head: boolean; cells: Cell[] };
type Segment = { text: string; font: Font };

const CELL = "cm-file-table-cell";
const HEAD = "cm-file-table-head";
const RULE = "cm-file-table-rule";
const FIRST = "cm-file-table-first";
const CELL_PADDING = 1;
const CELL_SLACK = 0.1;
const AVAILABLE_MARGIN = 2;
const SKIPPED = new Set(["EmphasisMark", "CodeMark", "LinkMark", "LinkLabel", "LinkTitle"]);
const LINK_TARGETS = new Set(["Link", "Image"]);

function wide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f300
  );
}

export const estimateWidth: TextWidth = (text, font) => {
  let width = 0;
  for (const char of text) width += wide(char.codePointAt(0) ?? 0) ? 1 : 0.6;
  return font.bold ? width * 1.05 : width;
};

export function measureWidth(view: EditorView, base: "sans" | "mono"): TextWidth {
  const context =
    typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  if (context === null) return estimateWidth;
  const root = view.dom.ownerDocument;
  const style = root.defaultView?.getComputedStyle(root.documentElement);
  const family = (name: "sans" | "mono") =>
    style?.getPropertyValue(`--font-${name}`).trim() ||
    (name === "mono" ? "monospace" : "sans-serif");
  const sans = family(base);
  const mono = family("mono");
  return (text, font) => {
    context.font = `${font.bold ? 700 : 400} 100px ${font.mono ? mono : sans}`;
    return context.measureText(text).width / 100;
  };
}

const relayout = StateEffect.define<null>();

function availableWidth(view: EditorView): number {
  const width = view.contentDOM.clientWidth;
  if (width === 0) return Number.POSITIVE_INFINITY;
  const line = view.contentDOM.querySelector(`.${CELL}`)?.closest(".cm-line") ?? view.contentDOM;
  const style = view.dom.ownerDocument.defaultView?.getComputedStyle(line);
  return width / (Number.parseFloat(style?.fontSize ?? "") || 16) - AVAILABLE_MARGIN;
}

export class TableLayout {
  readonly width: TextWidth;
  available = Number.POSITIVE_INFINITY;
  private destroyed = false;
  private readonly stopFonts: () => void;

  constructor(view: EditorView, base: "sans" | "mono") {
    this.width = measureWidth(view, base);
    const fonts = view.dom.ownerDocument.fonts as FontFaceSet | undefined;
    const reload = () => this.dispatch(view);
    fonts?.addEventListener("loadingdone", reload);
    this.stopFonts = () => fonts?.removeEventListener("loadingdone", reload);
    this.measure(view);
  }
  changed(update: ViewUpdate): boolean {
    if (update.geometryChanged) this.measure(update.view);
    return update.transactions.some((tr) => tr.effects.some((effect) => effect.is(relayout)));
  }
  destroy(): void {
    this.destroyed = true;
    this.stopFonts();
  }
  private measure(view: EditorView): void {
    view.requestMeasure({
      key: this,
      read: availableWidth,
      write: (available) => {
        if (available === this.available || Math.abs(available - this.available) < 0.5) return;
        this.available = available;
        queueMicrotask(() => this.dispatch(view));
      },
    });
  }
  private dispatch(view: EditorView): void {
    if (!this.destroyed) view.dispatch({ effects: relayout.of(null) });
  }
}

export function fitColumns(needs: number[], available: number): number[] {
  const fitted = [...needs];
  if (needs.reduce((sum, need) => sum + need, 0) <= available) return fitted;
  let open = needs.map((_, index) => index);
  let remaining = available;
  for (;;) {
    const fair = remaining / open.length;
    const small = open.filter((index) => needs[index] <= fair);
    if (small.length === 0) {
      for (const index of open) fitted[index] = fair;
      return fitted;
    }
    for (const index of small) remaining -= needs[index];
    open = open.filter((index) => needs[index] > fair);
  }
}

export function imageLabel(alt: string): string {
  return `[画像: ${alt.replace(/\s+/g, " ")}]`;
}

function shownSegments(doc: Text, node: SyntaxNode, offset: number, font: Font): Segment[] {
  const segments: Segment[] = [];
  let cursor = node.from;
  const text = (to: number) => {
    if (cursor < to) segments.push({ text: doc.sliceString(cursor + offset, to + offset), font });
  };
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    text(child.from);
    cursor = child.to;
    if (SKIPPED.has(child.name)) continue;
    if (child.name === "URL" && LINK_TARGETS.has(node.name)) continue;
    if (child.name === "Image") {
      const [opening, closing] = child.getChildren("LinkMark");
      const alt =
        opening && closing ? doc.sliceString(opening.to + offset, closing.from + offset) : "";
      segments.push({ text: imageLabel(alt), font });
      continue;
    }
    const inner =
      child.name === "StrongEmphasis"
        ? { ...font, bold: true }
        : child.name === "InlineCode"
          ? { ...font, mono: true }
          : font;
    segments.push(...shownSegments(doc, child, offset, inner));
  }
  text(node.to);
  return segments;
}

function cellClass(head: boolean, column: number): string {
  return [CELL, ...(head ? [HEAD] : []), ...(column === 0 ? [FIRST] : [])].join(" ");
}

class EmptyCells extends WidgetType {
  private readonly widths: string[];
  private readonly start: number;
  private readonly head: boolean;

  constructor(widths: string[], start: number, head: boolean) {
    super();
    this.widths = widths;
    this.start = start;
    this.head = head;
  }
  eq(other: EmptyCells): boolean {
    return (
      other.head === this.head &&
      other.start === this.start &&
      other.widths.join() === this.widths.join()
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = view.dom.ownerDocument.createElement("span");
    this.widths.forEach((width, index) => {
      const cell = view.dom.ownerDocument.createElement("span");
      cell.className = cellClass(this.head, this.start + index);
      cell.setAttribute("style", width);
      wrap.append(cell);
    });
    return wrap;
  }
}

function aligns(source: string): Align[] {
  return source
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((part): Align => {
      const spec = part.trim();
      if (spec.startsWith(":") && spec.endsWith(":")) return "center";
      if (spec.endsWith(":")) return "right";
      if (spec.startsWith(":")) return "left";
      return undefined;
    });
}

function rowCells(row: SyntaxNode): Cell[] {
  const cells: Cell[] = [];
  let pipes = 0;
  const leading = row.firstChild?.name === "TableDelimiter" ? 1 : 0;
  for (let child = row.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableDelimiter") pipes += 1;
    else if (child.name === "TableCell") cells.push({ node: child, column: pipes - leading });
  }
  return cells;
}

export function tableRanges(
  doc: Text,
  table: SyntaxNode,
  offset: number,
  active: number,
  width: TextWidth,
  available: number,
): Range<Decoration>[] {
  const rows: Row[] = [];
  const widths: number[] = [];
  let align: Align[] = [];
  let rule: number | null = null;
  for (let child = table.firstChild; child !== null; child = child.nextSibling) {
    const line = doc.lineAt(child.from + offset).number;
    if (child.name === "TableDelimiter") {
      align = aligns(doc.line(line).text);
      rule = line;
      continue;
    }
    const head = child.name === "TableHeader";
    const cells = rowCells(child);
    rows.push({ line, head, cells });
    for (const cell of cells) {
      const shown = shownSegments(doc, cell.node, offset, { bold: head, mono: false }).reduce(
        (sum, segment) => sum + width(segment.text, segment.font),
        0,
      );
      widths[cell.column] = Math.max(widths[cell.column] ?? 0, shown);
    }
  }
  const columns = Math.max(widths.length, align.length);
  for (let column = 0; column < columns; column += 1) widths[column] ??= 0;
  const fitted = fitColumns(
    widths.map((value) => value + CELL_PADDING + CELL_SLACK),
    available,
  );
  const total = fitted.reduce((sum, value) => sum + value, 0);
  const cellWidth = (column: number) => `--cell-width:${fitted[column]}em`;

  const ranges: Range<Decoration>[] = [];
  const gap = (from: number, to: number, start: number, end: number, head: boolean) => {
    const styles = [];
    for (let column = start; column < end; column += 1) styles.push(cellWidth(column));
    const widget = start < end ? new EmptyCells(styles, start, head) : undefined;
    if (from < to) ranges.push(Decoration.replace({ widget }).range(from, to));
    else if (widget) ranges.push(Decoration.widget({ widget, side: 1 }).range(from));
  };
  for (const row of rows) {
    if (row.line === active) continue;
    const line = doc.line(row.line);
    let cursor = line.from;
    let next = 0;
    for (const cell of row.cells) {
      const from = cell.node.from + offset;
      const to = cell.node.to + offset;
      gap(cursor, from, next, cell.column, row.head);
      const styles = [cellWidth(cell.column)];
      const side = align[cell.column];
      if (side !== undefined) styles.push(`text-align:${side}`);
      ranges.push(
        Decoration.mark({
          inclusive: true,
          class: cellClass(row.head, cell.column),
          attributes: { style: styles.join(";") },
        }).range(from, to),
      );
      cursor = to;
      next = cell.column + 1;
    }
    gap(cursor, line.to, next, columns, row.head);
  }
  if (rule !== null && rule !== active) {
    const line = doc.line(rule);
    ranges.push(
      Decoration.line({ class: RULE, attributes: { style: `--table-width:${total}em` } }).range(
        line.from,
      ),
    );
    if (line.from < line.to) ranges.push(Decoration.replace({}).range(line.from, line.to));
  }
  return ranges;
}

export const tableTheme = {
  [`.${CELL}`]: {
    display: "inline-block",
    boxSizing: "border-box",
    width: "var(--cell-width)",
    padding: `0 ${CELL_PADDING / 2}em`,
    borderLeft: "1px solid var(--color-line)",
    verticalAlign: "top",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  [`.${FIRST}`]: { borderLeft: "none" },
  [`.${CELL}:empty::before`]: { content: '"\\200b"' },
  [`.${HEAD}`]: { fontWeight: "700" },
  [`.${CELL} .cm-file-inline-code`]: { lineHeight: "1" },
  [`.${RULE}`]: {
    lineHeight: "0.6em",
    background:
      "linear-gradient(var(--color-line), var(--color-line)) no-repeat 0 50% / var(--table-width) 1px",
    backgroundOrigin: "content-box",
  },
};
