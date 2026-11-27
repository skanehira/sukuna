import { describe, expect, it } from "vite-plus/test";
import { ChangeSet, EditorState } from "@codemirror/state";
import {
  bufferChangeAnnotation,
  bufferChangeFilter,
  bufferColumns,
  bufferContentEffect,
  bufferField,
  initialBufferView,
} from "./state";
import { appendLines, contentText, createContent, type BufferContent } from "./tail";
import type { LineInfo } from "./line";

function text(value: string): LineInfo {
  return { kind: "text", text: value };
}

describe("読み取り専用のバッファの変更の受け付け", () => {
  it("印の付いていない変更は入らない", () => {
    const state = EditorState.create({
      doc: "a\nb",
      extensions: [
        bufferChangeFilter,
        bufferColumns.of([]),
        bufferField.init((current) =>
          initialBufferView(current, createContent([text("a"), text("b")]), []),
        ),
      ],
    });

    const next = state.update({ changes: { from: 0, to: 1, insert: "X" } }).state;

    expect(next.doc.toString()).toBe("a\nb");
    expect(next.field(bufferField).lines.map((line) => line.text)).toEqual(["a", "b"]);
  });

  it("追記の印の付いた変更だけが入る", () => {
    const content = createContent([text("a"), text("b")]);
    const state = EditorState.create({
      doc: contentText(content),
      extensions: [
        bufferChangeFilter,
        bufferColumns.of([]),
        bufferField.init((current) => initialBufferView(current, content, [])),
      ],
    });
    const op = appendLines(content, [text("c")], []);

    const next = state.update({
      changes: ChangeSet.of(op.specs, state.doc.length),
      effects: bufferContentEffect.of({ content: op.content, rebuild: op.rebuild }),
      annotations: bufferChangeAnnotation.of(true),
    }).state;

    expect(next.doc.toString()).toBe("a\nb\nc");
    expect(next.field(bufferField).lines.map((line) => line.text)).toEqual(["a", "b", "c"]);
  });
});

describe("装飾の作り直し", () => {
  it("追記した行に、行の種類の装飾が付く", () => {
    const content: BufferContent = createContent([text("a")]);
    const state = EditorState.create({
      doc: contentText(content),
      extensions: [
        bufferColumns.of([]),
        bufferField.init((current) => initialBufferView(current, content, [])),
      ],
    });
    const op = appendLines(content, [{ kind: "tool", text: "vp test" }], []);

    const next = state.update({
      changes: ChangeSet.of(op.specs, state.doc.length),
      effects: bufferContentEffect.of({ content: op.content, rebuild: op.rebuild }),
    }).state;
    const classes: string[] = [];
    const cursor = next.field(bufferField).decorations.iter();
    while (cursor.value !== null) {
      if (cursor.from === cursor.to && cursor.from === next.doc.line(2).from) {
        classes.push(cursor.value.spec.class);
      }
      cursor.next();
    }

    expect(classes).toContain("cm-kind-tool");
  });
});
