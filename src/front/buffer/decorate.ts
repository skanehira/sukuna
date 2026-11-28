import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import { columnSpans, columnWidth, type ColumnDef, type LineInfo, type LineKind } from "./line";
import {
  BAND_AI,
  BAND_FIRST,
  BAND_LAST,
  BAND_YOU,
  COLUMN,
  COLUMN_HANG,
  KIND_CLASS,
  MENU,
  MENU_DANGER,
  MENU_DONE,
  MENU_EFFECT,
  MENU_END,
  MENU_MAIN,
  MENU_NAME,
  MENU_NUMBER,
  MENU_START,
  STRONG,
  TOOL_ELBOW,
  speakerTagClass,
  toneClass,
} from "./theme";

const BOUNDARY: ReadonlySet<LineKind> = new Set<LineKind>([
  "speaker",
  "separator",
  "heading",
  "section",
  "row",
  "note",
  "queued",
]);

const PAD: Partial<Record<LineKind, number>> = { heading: 14, speaker: 4, section: 8 };

const TOOL_RESULT_HEAD = "  ⎿";

const MENU_WIDTHS = [1.4, 17, 13];
const MENU_SHARE = 76;
const MENU_GAP = 6;
const YOU = "あなた";

type Band = "you" | "ai";

function speakerBand(line: LineInfo): Band | null {
  if (line.kind !== "speaker") return null;
  return line.text === YOU ? "you" : "ai";
}

function bandOf(lines: LineInfo[], index: number): Band | null {
  for (let current = index; current >= 0; current -= 1) {
    const band = speakerBand(lines[current]);
    if (band !== null) return band;
    if (BOUNDARY.has(lines[current].kind)) return null;
  }
  return null;
}

function isBody(line: LineInfo | undefined): boolean {
  return line !== undefined && !BOUNDARY.has(line.kind) && line.kind !== "menu";
}

function isMenu(line: LineInfo | undefined): boolean {
  return line?.kind === "menu";
}

function paddingStyle(lines: LineInfo[], index: number): string | null {
  const base = PAD[lines[index].kind] ?? 0;
  const gapTop = !isMenu(lines[index]) && isMenu(lines[index - 1]) ? MENU_GAP : 0;
  const gapBottom = !isMenu(lines[index]) && isMenu(lines[index + 1]) ? MENU_GAP : 0;
  if (base === 0 && gapTop === 0 && gapBottom === 0) return null;
  let style = base === 0 ? "" : `padding-top:${base}px`;
  if (gapTop !== 0 || gapBottom !== 0) {
    style += `${style === "" ? "" : ";"}border-top:${gapTop}px solid transparent;border-bottom:${gapBottom}px solid transparent;background-clip:padding-box`;
  }
  return style;
}

function columnClasses(line: LineInfo, def: ColumnDef | undefined, index: number): string[] {
  const classes = [COLUMN];
  if (line.kind === "menu") {
    classes.push(index === 0 ? MENU_NUMBER : index === 1 ? MENU_NAME : MENU_EFFECT);
    if (line.main === true && index <= 1) classes.push(MENU_MAIN);
    if (line.danger === true && index === 1) classes.push(MENU_DANGER);
    if (line.done === true && index === 1) classes.push(MENU_DONE);
  }
  for (const name of def?.classes?.[index]?.split(" ") ?? []) {
    if (name !== "") classes.push(name);
  }
  return classes;
}

function columnStyle(line: LineInfo, def: ColumnDef | undefined, index: number): string | null {
  const menu = line.kind === "menu";
  const widths = def?.widths ?? (menu ? MENU_WIDTHS : []);
  const width = columnWidth(widths, index, menu ? MENU_SHARE : undefined);
  const align = menu ? undefined : def?.align?.[index];
  const parts: string[] = [];
  if (width !== null) parts.push(`width:${width}`);
  if (align === "right") parts.push("text-align:right");
  if (def?.wrap) parts.push("vertical-align:top");
  if (def?.wrap?.[index]) parts.push("white-space:pre-wrap", "overflow-wrap:anywhere");
  return parts.length === 0 ? null : parts.join(";");
}

function mark(
  lineFrom: number,
  span: { from: number; to: number },
  classes: string[],
  style: string | null,
): Range<Decoration> {
  if (span.from === span.to) {
    return Decoration.widget({ widget: new EmptyColumn(classes.join(" "), style), side: 1 }).range(
      lineFrom + span.from,
    );
  }
  return Decoration.mark({
    class: classes.join(" "),
    ...(style === null ? {} : { attributes: { style } }),
  }).range(lineFrom + span.from, lineFrom + span.to);
}

class EmptyColumn extends WidgetType {
  private readonly classes: string;
  private readonly style: string | null;

  constructor(classes: string, style: string | null) {
    super();
    this.classes = classes;
    this.style = style;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = this.classes;
    if (this.style !== null) span.setAttribute("style", this.style);
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function progressStyle(parts: number[]): string {
  let cursor = 0;
  const colors = ["done", "doing", "wait", "line"];
  const gradient = colors.map((color, index) => {
    const from = cursor;
    cursor = Math.min(100, cursor + Math.max(0, parts[index] ?? 0) * 100);
    return `var(--color-${color}) ${from}% ${cursor}%`;
  });
  return `background:linear-gradient(to right,${gradient.join(",")}) center / 100% 6px no-repeat`;
}

function lineDecoration(
  lines: LineInfo[],
  index: number,
  band: Band | null,
  def: ColumnDef | undefined,
): Decoration {
  const line = lines[index];
  const classes = [`${KIND_CLASS}${line.kind}`];
  if (line.kind === "menu") {
    classes.push(MENU);
    if (!isMenu(lines[index - 1])) classes.push(MENU_START);
    if (!isMenu(lines[index + 1])) classes.push(MENU_END);
  } else if (isBody(line) && band !== null) {
    classes.push(band === "you" ? BAND_YOU : BAND_AI);
    if (!isBody(lines[index - 1])) classes.push(BAND_FIRST);
    if (!isBody(lines[index + 1])) classes.push(BAND_LAST);
  }
  if (line.strong === true) classes.push(STRONG);
  if (line.tone !== undefined) classes.push(toneClass(line.tone));
  if (line.kind === "pair" && (def?.widths[0] ?? 0) > 0) classes.push(COLUMN_HANG);

  const style = [
    paddingStyle(lines, index),
    line.progress ? progressStyle(line.progress) : null,
    line.kind === "pair" && (def?.widths[0] ?? 0) > 0
      ? `padding-left:calc(${def?.widths[0]}rem + 16px);text-indent:calc(-${def?.widths[0]}rem - 8px)`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(";");

  return Decoration.line({
    class: classes.join(" "),
    ...(style === "" ? {} : { attributes: { style } }),
  });
}

export function buildDecorations(
  state: EditorState,
  lines: LineInfo[],
  from: number,
  to: number,
  columns: ColumnDef[],
): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  let band = from === 0 ? null : bandOf(lines, from - 1);

  for (let index = from; index < to && index < lines.length; index += 1) {
    if (index + 1 > state.doc.lines) break;
    const line = lines[index];
    const docLine = state.doc.line(index + 1);
    const def = columns.find((column) => column.name === line.colDef);

    if (line.kind === "speaker") {
      band = speakerBand(line);
    } else if (BOUNDARY.has(line.kind)) {
      band = null;
    }

    ranges.push(lineDecoration(lines, index, band, def).range(docLine.from));

    if (line.kind === "speaker" && docLine.length > 0 && band !== null) {
      ranges.push(
        Decoration.mark({ class: speakerTagClass(band) }).range(docLine.from, docLine.to),
      );
    }

    if (line.kind === "tool" && line.text.startsWith(TOOL_RESULT_HEAD)) {
      const elbow = docLine.from + TOOL_RESULT_HEAD.length - 1;
      ranges.push(Decoration.mark({ class: TOOL_ELBOW }).range(elbow, elbow + 1));
    }

    const spans = columnSpans(line);
    spans.forEach((span, columnIndex) => {
      ranges.push(
        mark(
          docLine.from,
          span,
          columnClasses(line, def, columnIndex),
          columnStyle(line, def, columnIndex),
        ),
      );
    });
  }

  return ranges;
}
