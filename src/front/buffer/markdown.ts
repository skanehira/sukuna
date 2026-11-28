import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { markdownRanges, markdownTheme } from "../lib/files/markdown-decorations";
import { findMermaid, mermaidField, mermaidWidget } from "../lib/files/markdown-mermaid";
import { TableLayout } from "../lib/files/markdown-table";
import type { LineInfo } from "./line";
import { bufferField } from "./state";

function sameMessage(a: LineInfo | undefined, b: LineInfo): boolean {
  return a?.markdown === true && a.seq === b.seq;
}

function build(view: EditorView, layout: TableLayout): DecorationSet {
  const { doc, selection } = view.state;
  const lines = view.state.field(bufferField).lines;
  const active = doc.lineAt(selection.main.head).number;
  const ranges: Range<Decoration>[] = [];
  const limit = Math.min(lines.length, doc.lines);
  let done = -1;
  for (const visible of view.visibleRanges) {
    const last = Math.min(doc.lineAt(visible.to).number, limit);
    for (let index = Math.max(doc.lineAt(visible.from).number - 1, done + 1); index < last;) {
      const line = lines[index];
      if (line.markdown !== true) {
        index += 1;
        continue;
      }
      let start = index;
      while (start > 0 && sameMessage(lines[start - 1], line)) start -= 1;
      let end = index;
      while (end + 1 < limit && sameMessage(lines[end + 1], line)) end += 1;
      ranges.push(
        ...markdownRanges(doc, active, doc.line(start + 1).from, doc.line(end + 1).to, {
          width: layout.width,
          available: layout.available,
        }),
      );
      done = end;
      index = end + 1;
    }
  }
  return Decoration.set(ranges, true);
}

function messageMermaid(state: EditorState): Range<Decoration>[] {
  const { doc } = state;
  const lines = state.field(bufferField).lines;
  const limit = Math.min(lines.length, doc.lines);
  const ranges: Range<Decoration>[] = [];
  for (let index = 0; index < limit;) {
    const line = lines[index];
    let end = index;
    if (line.markdown === true) {
      while (end + 1 < limit && sameMessage(lines[end + 1], line)) end += 1;
      ranges.push(...findMermaid(doc, index + 1, end + 1).map(mermaidWidget));
    }
    index = end + 1;
  }
  return ranges;
}

export const messageMarkdown = [
  mermaidField(
    messageMermaid,
    (tr) => tr.docChanged || tr.startState.field(bufferField) !== tr.state.field(bufferField),
  ),
  ViewPlugin.fromClass(
    class {
      layout: TableLayout;
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.layout = new TableLayout(view, "sans");
        this.decorations = build(view, this.layout);
      }
      update(update: ViewUpdate) {
        if (
          this.layout.changed(update) ||
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.startState.field(bufferField) !== update.state.field(bufferField)
        )
          this.decorations = build(update.view, this.layout);
      }
      destroy() {
        this.layout.destroy();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
  markdownTheme,
];
