import type { Extension } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
import { markField, type BufferMarks } from "./marks";
import { bufferField } from "./state";
import { CURSOR_NUMBER, MARK_GUTTER, NUM_GUTTER, sideMetrics, type BufferSide } from "./theme";

class MarkMarker extends GutterMarker {
  private readonly value: string;

  constructor(value: string) {
    super();
    this.value = value;
  }

  eq(other: GutterMarker): boolean {
    return other instanceof MarkMarker && other.value === this.value;
  }

  toDOM(): Node {
    const element = document.createElement("span");
    element.textContent = this.value;
    return element;
  }
}

class NumberMarker extends GutterMarker {
  private readonly value: string;
  private readonly cursor: boolean;

  constructor(value: string, cursor: boolean) {
    super();
    this.value = value;
    this.cursor = cursor;
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof NumberMarker && other.value === this.value && other.cursor === this.cursor
    );
  }

  toDOM(): Node {
    const element = document.createElement("span");
    element.textContent = this.value;
    if (this.cursor) element.className = CURSOR_NUMBER;
    return element;
  }
}

function markGutter(field?: ReturnType<typeof markField>): Extension {
  return gutter({
    class: MARK_GUTTER,
    renderEmptyElements: true,
    lineMarkerChange: (update) =>
      update.startState.field(bufferField).lines !== update.state.field(bufferField).lines ||
      (field !== undefined && update.startState.field(field) !== update.state.field(field)),
    lineMarker(view, block) {
      const index = view.state.doc.lineAt(block.from).number - 1;
      const mark =
        (field && view.state.field(field).get(index)) ??
        view.state.field(bufferField).lines[index]?.mark;
      if (mark === undefined || mark === "") return null;
      return new MarkMarker(mark);
    },
  });
}

function numberGutter(): Extension {
  return gutter({
    class: NUM_GUTTER,
    lineMarkerChange: (update) => update.selectionSet || update.docChanged,
    lineMarker(view, block) {
      const number = view.state.doc.lineAt(block.from).number;
      const cursor = view.state.doc.lineAt(view.state.selection.main.head).number;
      return new NumberMarker(String(number), number === cursor);
    },
  });
}

export function bufferGutters(side: BufferSide, marks?: BufferMarks): Extension[] {
  const field = marks && markField(marks);
  const extensions: Extension[] = field ? [field, markGutter(field)] : [markGutter()];
  if (sideMetrics(side).numbers) extensions.push(numberGutter());
  return extensions;
}
