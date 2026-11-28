import { useRef, useState } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: xterm.js と専用 WebSocket を画面の寿命に合わせて管理する
import { useEffect } from "react";
import type { OpenTerminalInput, TerminalOpened } from "../../../shared/api/terminal";
import type { StockItem } from "../../../shared/stock";
import { Buffer, type BufferHandle } from "../../buffer/Buffer";
import type { BufferController } from "../../buffer/controller";
import { Frame } from "../../buffer/Frame";
import type { ActionContext } from "../../buffer/keymap/registry";
import type { LineInfo } from "../../buffer/line";
import { TerminalInput } from "../../buffer/terminal";
import type { Conversation } from "../../lib/conversation/types";
import type { StockApi } from "../../lib/stock/api";
import { StockSession } from "../../lib/stock/session";
import { makeQuote } from "../../lib/stock/quote";
import type { FindWorktreeLocation } from "../../lib/worktree-location";
import { parseRoute } from "../../lib/routes";
import {
  sendTerminalInput,
  type CreateSurface,
  type InputFrame,
  type TerminalConnect,
  type TerminalSurface,
} from "./terminal-client";

export type TerminalRecord = {
  opened: TerminalOpened;
  input: OpenTerminalInput;
  projectName: string;
};
export type TerminalMode = "input" | "normal";
export type TerminalPort = {
  connect: TerminalConnect;
  createSurface: CreateSurface;
  exists(id: string, signal: AbortSignal): Promise<boolean>;
  restart(record: TerminalRecord): Promise<TerminalRecord>;
};
type Status =
  | { kind: "connecting" | "ready" | "failed" | "missing" }
  | { kind: "ended"; code: number };

const viewName = "terminal-output";
const normalHints: [string, string][] = [
  ["prompt.open", "入力へ戻る"],
  ["stock.question", "質問"],
  ["stock.instruct", "指示"],
  ["back", "戻る"],
];
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "ターミナルを開けませんでした";

export function createTerminalComposer(
  controller: BufferController,
  findDestination: (id: string) => Promise<Pick<Conversation, "title"> | null>,
  stock: StockApi,
) {
  const missing = "送り先の会話がありません。会話か issue を開いてから押してください";
  return async function compose(
    kind: StockItem["kind"],
    context: ActionContext,
    record: TerminalRecord,
  ): Promise<"missing" | undefined> {
    const conversationId = record.opened.conversationId;
    if (!conversationId) {
      controller.notify(missing);
      return;
    }
    const source = controller.windowLines(context.window);
    const lines = source.map(({ text }) => text);
    const selected = context.selection ?? {
      mode: "line" as const,
      ranges: [{ line: context.line, from: 0, to: lines[context.line]?.length ?? 0 }],
    };
    const quote = makeQuote({ kind: "terminal" }, lines, {
      ...selected,
      ranges: selected.ranges.filter(({ line }) => source[line]?.kind === "code"),
    });
    if (!quote) return;
    if (Array.from(quote.text).length > 20_000) {
      controller.notify("選んだ範囲が長すぎます。20,000 文字以内で選んでください", "error");
      return;
    }
    const opening = controller.screenOpening();
    const intent = controller.interactionRevision();
    const target = await findDestination(conversationId);
    if (controller.screenOpening() !== opening || controller.interactionRevision() !== intent)
      return;
    if (!target) {
      controller.notify(missing);
      return "missing";
    }
    new StockSession(conversationId, stock, controller).compose(kind, target.title, quote);
  };
}

export function registerTerminalOpen(
  controller: BufferController,
  locate: FindWorktreeLocation,
  open: (input: OpenTerminalInput) => Promise<TerminalOpened>,
  show: (record: TerminalRecord) => void | Promise<void>,
  current?: (id: string) => TerminalRecord | undefined,
): () => void {
  let running = false;
  return controller.actions.register({
    name: "terminal.open",
    label: "ターミナル",
    group: "そのほか",
    where: "会話・issue・プロジェクト",
    async run() {
      if (running) return;
      running = true;
      const opening = controller.screenOpening();
      try {
        const route = parseRoute(controller.options.url ?? "/");
        if (route.kind === "terminal" && route.id) {
          const record = current?.(route.id);
          if (record) await controller.run("prompt.open");
          return;
        }
        const found = await locate(route, "terminal");
        if (controller.screenOpening() !== opening) return;
        if (!found) {
          controller.notify("プロジェクトを開いてから使えます");
          return;
        }
        const input = {
          projectId: found.projectId,
          worktreeId: found.source === "project" ? found.worktreeId : null,
          conversationId: found.conversationId,
          cols: 120,
          rows: 40,
        };
        const opened = await open(input);
        if (controller.screenOpening() !== opening) return;
        await show({ opened, input, projectName: found.projectName });
      } finally {
        running = false;
      }
    },
  });
}

function TerminalOutput({
  lines,
  tail,
  retry,
  terminalId,
}: {
  lines: string[];
  tail?: string;
  retry?: () => void;
  terminalId: string;
}) {
  const buffer = useRef<BufferHandle | null>(null);
  const previous = useRef<LineInfo[] | undefined>(undefined);
  const output: LineInfo[] = lines.map((text) => ({ kind: "code", text }));
  if (tail) output.push({ kind: "note", text: tail });
  if (retry) output.push({ kind: "menu", text: "再読み込み", open: retry, main: true });
  useEffect(() => {
    const old = previous.current;
    if (!old || !buffer.current) return;
    previous.current = output;
    let from = 0;
    while (
      from < old.length &&
      from < output.length &&
      old[from].text === output[from].text &&
      old[from].kind === output[from].kind
    )
      from++;
    if (from >= old.length && from >= output.length) return;
    if (from < old.length) {
      const end = Math.min(old.length, output.length);
      buffer.current.replace(from, old.length, output.slice(from, end));
      if (output.length > end) buffer.current.append(output.slice(end));
    } else buffer.current.append(output.slice(from));
  });
  return (
    <Buffer
      side="main"
      posKey={`terminal:${terminalId}`}
      viewName={viewName}
      lines={output}
      startLine={output.length - 1}
      restorePosition={false}
      followTail
      onReady={(handle) => {
        buffer.current = handle;
        previous.current = output;
      }}
    />
  );
}

export function TerminalPage({
  initial,
  initialMode,
  terminal,
  controller,
  remember,
  rememberMode,
  compose,
}: {
  initial: TerminalRecord;
  initialMode: TerminalMode;
  terminal: TerminalPort;
  controller: BufferController;
  remember(this: void, record: TerminalRecord): void;
  rememberMode(this: void, mode: TerminalMode): void;
  compose(
    this: void,
    kind: StockItem["kind"],
    context: ActionContext,
    record: TerminalRecord,
  ): Promise<"missing" | undefined>;
}) {
  const [record, setRecord] = useState(initial);
  const [mode, setMode] = useState(initialMode);
  const outputMode = useRef(initialMode);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [lines, setLines] = useState<string[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<TerminalSurface>(null);
  const retry = useRef<() => void>(() => {});
  const reopening = useRef(false);
  const title = `ターミナル  ${record.projectName} / ${record.opened.label}`;
  const id = record.opened.id;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const abort = new AbortController();
    let channel: ReturnType<TerminalConnect> | null = null;
    let ready = false;
    let ended = false;
    let generation = 0;
    let runningCheck = false;
    let resized: { cols: number; rows: number } | null = null;
    const send = (frame: InputFrame) => {
      if (ready) channel?.send(frame);
    };
    const input = (value: string) => sendTerminalInput(send, value);
    const term = terminal.createSurface(element, input);
    surface.current = term;
    const keyboard = new TerminalInput(controller, input);
    const normal = () => {
      outputMode.current = "normal";
      setLines(term.lines());
      setMode("normal");
      rememberMode("normal");
    };
    term.onKey((event) => {
      if (event.metaKey) return false;
      if (event.type !== "keydown") return true;
      if (keyboard.intercept(event)) {
        if (controller.snapshot().mode === "NORMAL") normal();
        return false;
      }
      if (event.ctrlKey && event.key === "[") {
        event.preventDefault();
        input("\u001b");
        return false;
      }
      return true;
    });
    const resize = () => {
      if (!ready || element.hidden) return;
      const size = term.fit();
      if (resized?.cols === size.cols && resized.rows === size.rows) return;
      resized = size;
      send({ type: "resize", ...size });
    };
    const stopResizing = term.observe(resize);
    const read = () => {
      if (!abort.signal.aborted && outputMode.current === "normal") setLines(term.lines());
    };

    async function reconnect(afterSnapshot: boolean) {
      if (runningCheck || abort.signal.aborted || ended) return;
      runningCheck = true;
      try {
        const exists = await terminal.exists(id, abort.signal);
        if (abort.signal.aborted) return;
        if (!exists) setStatus({ kind: "missing" });
        else if (afterSnapshot) start();
        else setStatus({ kind: "failed" });
        if (!exists || !afterSnapshot) normal();
      } catch {
        if (!abort.signal.aborted) {
          setStatus({ kind: "failed" });
          normal();
        }
      } finally {
        runningCheck = false;
      }
    }
    function start() {
      const connected = ++generation;
      ready = false;
      resized = null;
      channel?.close();
      setStatus({ kind: "connecting" });
      channel = terminal.connect(id, {
        frame(frame) {
          if (abort.signal.aborted || generation !== connected) return;
          if (frame.type === "snapshot") {
            term.reset();
            term.resize(frame.cols, frame.rows);
            term.write(frame.data, () => {
              if (abort.signal.aborted || generation !== connected) return;
              read();
              if (ended) return;
              ready = true;
              setStatus({ kind: "ready" });
              resize();
            });
          } else if (frame.type === "output") term.write(frame.data, read);
          else if (frame.type === "exit") {
            ended = true;
            ready = false;
            setStatus({ kind: "ended", code: frame.code });
            normal();
          } else controller.notify(frame.message, "error");
        },
        close() {
          if (generation !== connected || abort.signal.aborted) return;
          const afterSnapshot = ready;
          ready = false;
          void reconnect(afterSnapshot);
        },
      });
    }
    retry.current = () => {
      void reconnect(true);
    };
    start();
    return () => {
      abort.abort();
      stopResizing();
      channel?.close();
      term.dispose();
      surface.current = null;
      retry.current = () => {};
    };
  }, [controller, id, rememberMode, terminal]);

  useEffect(() => {
    if (mode !== "input") return;
    const focus = () => {
      surface.current?.focus();
      controller.update({ mode: "TERMINAL", number: "", prefix: "" });
    };
    return controller.registerWindow("main", {
      focus,
      lines: () => [],
      position: () => ({ line: 0, column: 0, topLine: 0 }),
      place() {},
      view: "terminal-input",
      name: title,
      posKey: `terminal-input:${id}`,
      url: controller.options.url ?? "/",
      scrollCursor() {},
      temporary: true,
    });
  }, [controller, id, mode, title]);

  useEffect(() => {
    const input = async () => {
      if (status.kind === "failed") {
        retry.current();
        return true;
      }
      if (status.kind === "missing" || status.kind === "ended") {
        if (reopening.current) return true;
        reopening.current = true;
        const opening = controller.screenOpening();
        try {
          const next = await terminal.restart(record);
          if (controller.screenOpening() !== opening) return true;
          remember(next);
          setRecord(next);
          setLines([]);
        } catch (error) {
          controller.notify(messageOf(error), "error");
          return true;
        } finally {
          reopening.current = false;
        }
      }
      outputMode.current = "input";
      setMode("input");
      rememberMode("input");
      surface.current?.scrollToBottom();
      return true;
    };
    controller.setHints(viewName, normalHints);
    const remove = [
      controller.registerActionInterceptor("prompt.open", { views: [viewName], run: input }),
      ...(["question", "instruction"] as const).map((kind) =>
        controller.registerActionInterceptor(
          kind === "question" ? "stock.question" : "stock.instruct",
          {
            views: [viewName],
            async run(context) {
              if ((await compose(kind, context, record)) === "missing") {
                const next = {
                  ...record,
                  opened: { ...record.opened, conversationId: null },
                  input: { ...record.input, conversationId: null },
                };
                remember(next);
                setRecord(next);
              }
              return true;
            },
          },
        ),
      ),
    ];
    return () => remove.forEach((stop) => stop());
  }, [compose, controller, record, remember, rememberMode, status.kind, terminal]);

  const tail =
    status.kind === "ended"
      ? `[終了しました (コード ${status.code})]`
      : status.kind === "missing"
        ? "ターミナルは終了しています (画面のサーバーが再起動しました)。i で新しく開きます"
        : status.kind === "failed"
          ? "ターミナルにつながりません"
          : undefined;

  return (
    <Frame title={title} side="main">
      <div
        ref={host}
        hidden={mode !== "input"}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-hidden px-3 pb-2"
        onFocus={() => {
          if (mode === "input" && controller.snapshot().mode !== "TERMINAL")
            controller.update({ active: "main", mode: "TERMINAL" });
        }}
      />
      {mode === "normal" && (
        <TerminalOutput
          lines={lines}
          tail={tail}
          retry={status.kind === "failed" ? () => retry.current() : undefined}
          terminalId={id}
        />
      )}
    </Frame>
  );
}
