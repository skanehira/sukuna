import { useRef } from "react";
// oxlint-disable-next-line no-restricted-imports -- CodeMirror の EditorView は要素の寿命に合わせて 1 度だけ作り、追記は dispatch で当てるため effect が要る
import { useEffect } from "react";
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine } from "@codemirror/view";
import { getCM, vim } from "@replit/codemirror-vim";
import type { ColumnDef, LineInfo } from "./line";
import { canPlaceCursor, initialLine, placeCursor } from "./no-cursor";
import { findSeqLine } from "./seq-index";
import {
  bufferChangeFilter,
  bufferColumns,
  bufferCursorFilter,
  bufferField,
  bufferTransaction,
  initialBufferView,
  type BufferTransactionOptions,
} from "./state";
import {
  appendLines,
  contentLines,
  contentText,
  createContent,
  replaceAllLines,
  replaceLines,
  setTailLines,
  tailPartRange,
  type BufferContent,
  type BufferOp,
  type LineRange,
  type TailPart,
} from "./tail";
import { bufferGutters } from "./gutters";
import { bufferTheme, type BufferSide } from "./theme";

export type BufferHandle = {
  append(lines: LineInfo[], clearTail?: TailPart[]): void;
  replace(from: number, to: number, lines: LineInfo[]): void;
  setTail(part: TailPart, lines: LineInfo[]): void;
  replaceAll(lines: LineInfo[]): void;
  jumpTo(line: number): void;
  findSeq(seq: number, seqLine?: number): number | null;
};

export type BufferProps = {
  side: BufferSide;
  lines: LineInfo[];
  columns?: ColumnDef[];
  startLine?: number;
  followTail?: boolean;
  onReady: (handle: BufferHandle) => void;
};

type CursorIntent =
  | { kind: "append" }
  | { kind: "setTail"; from: number; to: number; count: number }
  | { kind: "replace"; from: number; to: number; count: number }
  | { kind: "replaceAll" };

type Batch = {
  changes: ChangeSet;
  content: BufferContent;
  rebuild: LineRange;
  operations: { intent: CursorIntent; op: BufferOp; changes: ChangeSet }[];
};

function lineStart(lines: LineInfo[], index: number): number {
  let offset = 0;
  for (let current = 0; current < index && current < lines.length; current += 1) {
    offset += lines[current].text.length + 1;
  }
  return offset;
}

function unionRange(left: LineRange, right: LineRange, added: number): LineRange {
  return {
    from: Math.min(left.from, right.from),
    to: Math.max(left.to + Math.max(0, added), right.to),
  };
}

function isBusy(view: EditorView): boolean {
  const vimState = getCM(view)?.state.vim;
  if (vimState === undefined || vimState === null) return false;
  const input = vimState.inputState;
  return (
    vimState.visualMode ||
    vimState.insertMode ||
    vimState.status !== "" ||
    input.keyBuffer.length > 0 ||
    input.operator != null ||
    input.motion != null
  );
}

function cursorSelection(
  doc: Text,
  selection: EditorSelection,
  lines: LineInfo[],
  intent: CursorIntent,
  content: BufferContent,
  followTail: boolean,
): EditorSelection | undefined {
  const head = selection.main.head;
  const cursorLine = doc.lineAt(head).number - 1;
  const nextLines = contentLines(content);

  if (intent.kind === "append" || intent.kind === "setTail") {
    const onLastLine = lines.length === 0 || cursorLine === lines.length - 1;
    if (followTail && onLastLine && nextLines.length > 0) {
      return EditorSelection.single(lineStart(nextLines, nextLines.length - 1));
    }
    if (intent.kind === "append") return undefined;
  }

  if (intent.kind === "replace" || intent.kind === "setTail") {
    const from = Math.max(0, Math.min(intent.from, lines.length));
    const to = Math.max(from, Math.min(intent.to, lines.length));
    if (cursorLine < from || cursorLine >= to || nextLines.length === 0) return undefined;
    const offset = Math.min(cursorLine - from, Math.max(0, intent.count - 1));
    const target = Math.min(from + offset, nextLines.length - 1);
    const column = head - doc.line(cursorLine + 1).from;
    const start = lineStart(nextLines, target);
    return EditorSelection.single(Math.min(start + column, start + nextLines[target].text.length));
  }

  const id = lines[cursorLine]?.id;
  if (id !== undefined) {
    const index = nextLines.findIndex((line) => line.id === id);
    if (index >= 0) return EditorSelection.single(lineStart(nextLines, index));
  }
  if (nextLines.length === 0) return EditorSelection.single(0);
  const target = Math.max(0, Math.min(cursorLine, nextLines.length - 1));
  return EditorSelection.single(lineStart(nextLines, target));
}

export function Buffer({
  side,
  lines,
  columns,
  startLine,
  followTail = false,
  onReady,
}: BufferProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const batchRef = useRef<Batch | null>(null);
  const frameRef = useRef<number | null>(null);
  const configRef = useRef({ side, lines, columns: columns ?? [], startLine, followTail, onReady });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const config = configRef.current;
    const content = createContent(config.lines);
    const initial = initialLine(config.lines, config.startLine);
    const extensions: Extension[] = [
      vim(),
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      bufferChangeFilter,
      bufferCursorFilter,
      bufferColumns.of(config.columns),
      bufferField.init((state) => initialBufferView(state, content, config.columns)),
      ...bufferGutters(config.side),
      bufferTheme(config.side),
      EditorView.contentAttributes.of({ tabindex: "0", "aria-label": "バッファ" }),
    ];
    const state = EditorState.create({
      doc: contentText(content),
      selection: EditorSelection.single(
        config.lines.length === 0 ? 0 : lineStart(config.lines, initial),
      ),
      extensions,
    });
    const view = new EditorView({ parent: host, state });
    viewRef.current = view;

    const flush = (): void => {
      frameRef.current = null;
      const batch = batchRef.current;
      if (batch === null || viewRef.current !== view) return;
      batchRef.current = null;
      const options: BufferTransactionOptions = {};
      let doc = view.state.doc;
      let selection = view.state.selection;
      let currentLines = view.state.field(bufferField).lines;
      const follow = config.followTail && !isBusy(view);
      for (const { intent, op, changes } of batch.operations) {
        const resolved = cursorSelection(doc, selection, currentLines, intent, op.content, follow);
        selection = resolved ?? selection.map(changes);
        if (resolved !== undefined) {
          options.selection = selection;
          if (follow && (intent.kind === "append" || intent.kind === "setTail")) {
            options.scrollIntoView = true;
          }
        } else if (options.selection !== undefined) {
          options.selection = selection;
        }
        doc = changes.apply(doc);
        currentLines = contentLines(op.content);
      }
      view.dispatch(bufferTransaction(batch.changes, batch.content, batch.rebuild, options));
    };

    const enqueue = (
      intent: CursorIntent | ((base: BufferContent) => CursorIntent),
      build: (base: BufferContent) => BufferOp,
    ): void => {
      if (viewRef.current !== view) return;
      const batch = batchRef.current;
      const base = batch?.content ?? view.state.field(bufferField).content;
      const op = build(base);
      const changes = ChangeSet.of(op.specs, contentText(base).length);
      const operation = {
        intent: typeof intent === "function" ? intent(base) : intent,
        op,
        changes,
      };
      batchRef.current = {
        changes: batch === null ? changes : batch.changes.compose(changes),
        content: op.content,
        rebuild:
          batch === null
            ? op.rebuild
            : unionRange(
                batch.rebuild,
                op.rebuild,
                contentLines(op.content).length - contentLines(base).length,
              ),
        operations: [...(batch?.operations ?? []), operation],
      };
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush);
    };

    config.onReady({
      append(appendLines_, clearTail) {
        enqueue({ kind: "append" }, (base) => appendLines(base, appendLines_, clearTail ?? []));
      },
      replace(from, to, replaceLines_) {
        enqueue({ kind: "replace", from, to, count: replaceLines_.length }, (base) =>
          replaceLines(base, from, to, replaceLines_),
        );
      },
      setTail(part, tailLines) {
        enqueue(
          (base) => ({ kind: "setTail", ...tailPartRange(base, part), count: tailLines.length }),
          (base) => setTailLines(base, part, tailLines),
        );
      },
      replaceAll(allLines) {
        enqueue({ kind: "replaceAll" }, (base) => replaceAllLines(base, allLines));
      },
      jumpTo(line) {
        if (viewRef.current !== view) return;
        const currentLines = view.state.field(bufferField).lines;
        if (currentLines.length === 0) return;
        const index = Math.max(0, Math.min(line, currentLines.length - 1));
        const target = canPlaceCursor(currentLines[index])
          ? index
          : placeCursor(currentLines, index, index);
        view.dispatch({
          selection: EditorSelection.single(lineStart(currentLines, target)),
          scrollIntoView: true,
        });
      },
      findSeq(seq, seqLine) {
        return findSeqLine(view.state.field(bufferField).lines, seq, seqLine);
      },
    });

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      batchRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  return <div ref={hostRef} className="flex min-h-0 flex-1 flex-col [&>.cm-editor]:flex-1" />;
}
