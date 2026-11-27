import {
  Annotation,
  EditorSelection,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  type ChangeSet,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { buildDecorations } from "./decorate";
import { canPlaceCursor, placeCursor } from "./no-cursor";
import { contentLines, createContent, type BufferContent, type LineRange } from "./tail";
import type { ColumnDef, LineInfo } from "./line";

export const bufferChangeAnnotation = Annotation.define<boolean>();

export type BufferView = {
  content: BufferContent;
  lines: LineInfo[];
  decorations: DecorationSet;
};

export type BufferEffectValue = { content: BufferContent; rebuild: LineRange };

export const bufferContentEffect = StateEffect.define<BufferEffectValue>();

export const bufferColumns = Facet.define<ColumnDef[], ColumnDef[]>({
  combine: (values) => values.at(-1) ?? [],
});

function rebuildRange(
  view: BufferView,
  tr: Transaction,
  columns: ColumnDef[],
  value: BufferEffectValue,
): BufferView {
  const lines = contentLines(value.content);
  const decorations = view.decorations.map(tr.changes);
  const doc = tr.newDoc;
  const from = Math.max(0, Math.min(value.rebuild.from, lines.length));
  const to = Math.max(from, Math.min(value.rebuild.to, lines.length));
  const fromPos = from >= lines.length ? doc.length : doc.line(from + 1).from;
  const toPos = to >= lines.length ? doc.length : doc.line(to + 1).from;
  return {
    content: value.content,
    lines,
    decorations: decorations.update({
      filterFrom: fromPos,
      filterTo: toPos,
      filter: (position) => position < fromPos || (to < lines.length && position >= toPos),
      add: buildDecorations(tr.state, lines, from, to, columns),
    }),
  };
}

export const bufferField = StateField.define<BufferView>({
  create: () => ({ content: createContent([]), lines: [], decorations: Decoration.none }),
  update(value, tr) {
    const effect = tr.effects.find((item) => item.is(bufferContentEffect));
    if (effect === undefined) {
      return {
        content: value.content,
        lines: value.lines,
        decorations: value.decorations.map(tr.changes),
      };
    }
    return rebuildRange(value, tr, tr.state.facet(bufferColumns), effect.value);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function initialBufferView(
  state: EditorState,
  content: BufferContent,
  columns: ColumnDef[],
): BufferView {
  const lines = contentLines(content);
  return {
    content,
    lines,
    decorations: Decoration.set(buildDecorations(state, lines, 0, lines.length, columns), true),
  };
}

export type BufferTransactionOptions = {
  selection?: EditorSelection;
  scrollIntoView?: boolean;
};

export function bufferTransaction(
  changes: ChangeSet,
  content: BufferContent,
  rebuild: LineRange,
  options: BufferTransactionOptions = {},
): TransactionSpec {
  return {
    changes,
    effects: bufferContentEffect.of({ content, rebuild }),
    annotations: bufferChangeAnnotation.of(true),
    ...(options.selection === undefined ? {} : { selection: options.selection }),
    ...(options.scrollIntoView === true ? { scrollIntoView: true } : {}),
  };
}

export const bufferChangeFilter = EditorState.changeFilter.of(
  (tr) => tr.annotation(bufferChangeAnnotation) === true,
);

function linesOf(tr: Transaction): LineInfo[] {
  const effect = tr.effects.find((item) => item.is(bufferContentEffect));
  if (effect !== undefined) return contentLines(effect.value.content);
  return tr.startState.field(bufferField).lines;
}

export const bufferCursorFilter = EditorState.transactionFilter.of((tr) => {
  const selection = tr.newSelection;
  if (!selection.main.empty) return tr;
  const lines = linesOf(tr);
  const line = tr.newDoc.lineAt(selection.main.head).number - 1;
  const current = lines[line];
  if (current === undefined || canPlaceCursor(current)) return tr;
  const previous = tr.startState.doc.lineAt(tr.startState.selection.main.head).number - 1;
  const resolved = placeCursor(lines, previous, line);
  const annotated = tr.annotation(bufferChangeAnnotation) === true;
  return {
    changes: tr.changes,
    effects: tr.effects,
    ...(annotated ? { annotations: bufferChangeAnnotation.of(true) } : {}),
    selection: EditorSelection.single(tr.newDoc.line(resolved + 1).from),
    scrollIntoView: tr.scrollIntoView,
  };
});
