import { useContext, useRef, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- CodeMirror の EditorView は要素の寿命に合わせて 1 度だけ作り、追記は dispatch で当てるため effect が要る
import { useEffect } from "react";
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  scrollPastEnd as scrollBeyondEnd,
} from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import type { ColumnDef, LineInfo } from "./line";
import {
  BufferControllerContext,
  ScreenOpeningContext,
  windowId,
  type WindowHandle,
} from "./controller";
import type { SavedPosition } from "./position-store";
import { menuAt, numberMenus, numberMenuOperation } from "./menu";
import { FrameContext } from "./Frame";
import { applyVim, vimCount, vimMode } from "./keymap/apply-vim";
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
  replaceAll(lines: LineInfo[], options?: { missingCursorTarget?: string; ready?: boolean }): void;
  jumpTo(line: number, options?: { remember?: boolean; topLine?: number; column?: number }): void;
  cursorRevision?(): number;
  pushJump(line: number): void;
  findSeq(seq: number, seqLine?: number): number | null;
};

export type BufferProps = {
  side: BufferSide;
  posKey?: string;
  viewName?: string;
  name?: string;
  lines: LineInfo[];
  columns?: ColumnDef[];
  startLine?: number;
  followTail?: boolean;
  scrollPastEnd?: boolean;
  temporary?: boolean;
  ready?: boolean;
  onReady: (handle: BufferHandle) => void;
};

type CursorIntent =
  | { kind: "append" }
  | { kind: "setTail"; from: number; to: number; count: number }
  | { kind: "replace"; from: number; to: number; count: number }
  | { kind: "replaceAll"; missingCursorTarget?: string };

type Batch = {
  ready?: boolean;
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
  const positional = nextLines[target];
  if (
    intent.kind === "replaceAll" &&
    intent.missingCursorTarget &&
    (id !== undefined || positional.action || positional.target)
  ) {
    const fallback = nextLines.findIndex((line) => line.id === intent.missingCursorTarget);
    if (fallback >= 0) return EditorSelection.single(lineStart(nextLines, fallback));
  }
  return EditorSelection.single(lineStart(nextLines, target));
}

export function Buffer({
  side,
  posKey,
  viewName,
  name,
  lines,
  columns,
  startLine,
  followTail = false,
  scrollPastEnd = false,
  temporary = false,
  ready = true,
  onReady,
}: BufferProps) {
  const controller = useContext(BufferControllerContext);
  const frameTitle = useContext(FrameContext);
  const opening = useContext(ScreenOpeningContext);
  useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.snapshot ?? (() => null),
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const batchRef = useRef<Batch | null>(null);
  const frameRef = useRef<number | null>(null);
  const identity = useRef({});
  const previousAttachment = useRef<SavedPosition | null>(null);
  const configRef = useRef({
    side,
    lines,
    columns: columns ?? [],
    startLine,
    followTail,
    scrollPastEnd,
    onReady,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const config = configRef.current;
    let contentReady = ready;
    const content = createContent(numberMenus(config.lines));
    const initial = initialLine(config.lines, config.startLine);
    let rememberSelection = () => {};
    let cursorRevision = 0;
    const extensions: Extension[] = [
      EditorView.updateListener.of((update) => {
        if (
          !update.docChanged &&
          update.selectionSet &&
          update.startState.selection.main.head !== update.state.selection.main.head
        )
          cursorRevision++;
        if (update.selectionSet || update.docChanged) rememberSelection();
      }),
      vim(),
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      ...(config.scrollPastEnd ? [scrollBeyondEnd()] : []),
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
        config.lines.length === 0 ? 0 : lineStart(contentLines(content), initial),
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
      const number = Number(vimCount(view));
      let menuChanged = false;
      for (const { intent, op, changes } of batch.operations) {
        const nextLines = contentLines(op.content);
        let resolved = cursorSelection(doc, selection, currentLines, intent, op.content, follow);
        if (!menuChanged && number && intent.kind === "replaceAll" && intent.missingCursorTarget) {
          const menuId = menuAt(currentLines, number)?.line.id;
          if (menuId && menuAt(nextLines, number)?.line.id !== menuId) {
            const fallback = nextLines.findIndex((line) => line.id === intent.missingCursorTarget);
            if (fallback >= 0) {
              resolved = EditorSelection.single(lineStart(nextLines, fallback));
              menuChanged = true;
            }
          }
        }
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
        currentLines = nextLines;
      }
      view.dispatch(bufferTransaction(batch.changes, batch.content, batch.rebuild, options));
      if (menuChanged) {
        const cm = getCM(view);
        if (cm) Vim.handleKey(cm, "<Esc>", "mapping");
        if (controller?.snapshot().active === logicalSide) controller.update({ number: "" });
      }
      contentReady = batch.ready ?? contentReady;
      controller?.windowChanged(logicalSide, window);
    };
    const flushNow = (): void => {
      if (batchRef.current === null) return;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      flush();
    };

    const enqueue = (
      intent: CursorIntent | ((base: BufferContent) => CursorIntent),
      build: (base: BufferContent) => BufferOp,
      ready?: boolean,
    ): void => {
      if (viewRef.current !== view) return;
      const batch = batchRef.current;
      const base = batch?.content ?? view.state.field(bufferField).content;
      const op = numberMenuOperation(base, build(base));
      const changes = ChangeSet.of(op.specs, contentText(base).length);
      const operation = {
        intent: typeof intent === "function" ? intent(base) : intent,
        op,
        changes,
      };
      batchRef.current = {
        ready: ready ?? batch?.ready,
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

    const logicalSide = windowId(side);
    const window: WindowHandle = {
      identity: identity.current,
      ready: () => contentReady,
      name: name ?? frameTitle ?? side,
      url: controller?.options.url ?? "/",
      opening: logicalSide === "main" ? (opening ?? controller?.screenOpening()) : undefined,
      temporary,
      view: viewName ?? side,
      posKey: posKey ?? `${controller?.options.url ?? "/"}:${logicalSide}:${viewName ?? side}`,
      focus: () => {
        view.focus();
        controller?.update({ mode: vimMode(view), number: vimCount(view) });
      },
      lines: () => view.state.field(bufferField).lines,
      position: () => {
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const info = view.state.field(bufferField).lines[line.number - 1];
        return {
          line: line.number - 1,
          column: view.state.selection.main.head - line.from,
          topLine:
            view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number - 1,
          ...(info?.id ? { id: info.id } : {}),
        };
      },
      place: (position) => {
        const lines = view.state.field(bufferField).lines;
        const byId = position.id ? lines.findIndex((line) => line.id === position.id) : -1;
        const target = Math.max(
          0,
          Math.min(byId >= 0 ? byId : position.line, view.state.doc.lines - 1),
        );
        const line = view.state.doc.line(target + 1);
        view.dispatch({
          selection: EditorSelection.single(Math.min(line.to, line.from + position.column)),
          effects: EditorView.scrollIntoView(
            view.state.doc.line(Math.min(position.topLine + 1, view.state.doc.lines)).from,
            { y: "start" },
          ),
        });
      },
      scrollCursor: () =>
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) }),
    };
    const remember = () => {
      if (!temporary) controller?.positions.setPosition(window.posKey, window.position());
    };
    const focus = (event: FocusEvent) => {
      if (event.target !== view.contentDOM) return;
      controller?.positions.setActive(logicalSide);
      controller?.update({ active: logicalSide, mode: vimMode(view), number: vimCount(view) });
    };
    const doubleClick = () => {
      controller?.open();
    };
    const handle: BufferHandle = {
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
      replaceAll(allLines, { ready = true, missingCursorTarget } = {}) {
        enqueue(
          { kind: "replaceAll", missingCursorTarget },
          (base) => replaceAllLines(base, allLines),
          ready,
        );
      },
      jumpTo(line, options) {
        if (viewRef.current !== view) return;
        flushNow();
        if (options?.remember !== false) controller?.pushJump(logicalSide, window.position().line);
        const currentLines = view.state.field(bufferField).lines;
        if (currentLines.length === 0) return;
        const index = Math.max(0, Math.min(line, currentLines.length - 1));
        const target = canPlaceCursor(currentLines[index])
          ? index
          : placeCursor(currentLines, index, index);
        view.dispatch({
          selection: EditorSelection.single(
            lineStart(currentLines, target) +
              Math.min(options?.column ?? 0, currentLines[target].text.length),
          ),
          effects: EditorView.scrollIntoView(lineStart(currentLines, options?.topLine ?? target), {
            y: options?.topLine === undefined ? "nearest" : "start",
          }),
        });
      },
      cursorRevision: () => cursorRevision,
      pushJump(line) {
        flushNow();
        controller?.pushJump(logicalSide, line);
      },
      findSeq(seq, seqLine) {
        flushNow();
        return findSeqLine(view.state.field(bufferField).lines, seq, seqLine);
      },
    };
    const initialize = () => {
      config.onReady(handle);
      flushNow();
      if (previousAttachment.current) window.place(previousAttachment.current);
    };
    const unregister = controller?.registerWindow(logicalSide, window, initialize);
    if (!controller) initialize();
    const unmap = controller
      ? applyVim(view, controller, logicalSide, viewName ?? side)
      : undefined;
    rememberSelection = () => {
      remember();
      controller?.update({});
    };
    view.dom.addEventListener("focusin", focus);
    view.dom.addEventListener("dblclick", doubleClick);
    view.dom.addEventListener("keyup", remember);
    view.scrollDOM.addEventListener("scroll", remember);

    return () => {
      if (!temporary) previousAttachment.current = window.position();
      unregister?.();
      unmap?.();
      view.dom.removeEventListener("focusin", focus);
      view.dom.removeEventListener("dblclick", doubleClick);
      view.dom.removeEventListener("keyup", remember);
      view.scrollDOM.removeEventListener("scroll", remember);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      batchRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {controller?.busy(windowId(side)) ? (
        <div
          role="progressbar"
          aria-label="操作の実行中"
          className="absolute right-3 top-2 z-10 h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent"
        />
      ) : null}
      <div ref={hostRef} className="flex min-h-0 flex-1 flex-col [&>.cm-editor]:flex-1" />
    </div>
  );
}
