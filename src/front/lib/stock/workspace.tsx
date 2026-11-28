import type { Quote, StockItem } from "../../../shared/stock";
import type { ServerMessage } from "../../../shared/ws";
import type { BufferController } from "../../buffer/controller";
import type { ActionContext, ActionDef } from "../../buffer/keymap/registry";
import type { LineInfo } from "../../buffer/line";
import { isThreadRight, type RightView } from "../../buffer/right-window";
import { StockWindow, stockView } from "../../components/stock/StockWindow";
import { ThreadList, threadListView } from "../../components/stock/ThreadList";
import { ThreadWindow, stockThreadView } from "../../components/stock/ThreadWindow";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import { ConversationApiError } from "../conversation/api";
import type { ConversationApi, Conversation } from "../conversation/types";
import { ConversationSession, type ConversationEnvironment } from "../conversation/session";
import { relativeFilePath } from "../files/path-at-cursor";
import { parseRoute, routeUrl } from "../routes";
import type { StockApi } from "./api";
import type { StockMark } from "./marks";
import { conversationSource, designSource, fileSource, makeQuote } from "./quote";
import { StockSession } from "./session";

const designView = "issue-design";
const quoteViews = ["conversation", "file", "markdown-file", designView];
const undoViews = [stockView, ...quoteViews];
type Scope = Pick<Conversation, "id" | "title" | "issueId"> & { cwd?: string };
export function designMarks(stock: StockSession, lines: readonly LineInfo[]) {
  const paths = new Set(lines.flatMap(({ designDiff }) => (designDiff ? [designDiff.path] : [])));
  return new Map(
    [...paths].flatMap((path) => [
      ...stock.marks((viewLines) => designSource(path, viewLines), lines),
    ]),
  );
}

type UndoEntry = {
  order: number;
  stock: StockSession;
  id: string;
  waiting: boolean;
  restoring: boolean;
};
const definitiveCancelFailure = (error: unknown) =>
  error instanceof ConversationApiError && [400, 401, 403, 404, 409].includes(error.status);

export function createStockWorkspace({
  api,
  controller,
  conversations,
  env,
  subscribe,
  showConversation,
  openFile,
  queuedId,
  lookup,
}: {
  api: StockApi;
  controller: BufferController;
  conversations: ConversationApi;
  env: ConversationEnvironment;
  subscribe: LifecycleFeed;
  showConversation(this: void, id: string): () => void;
  lookup?(this: void, id: string): Scope | undefined;
  queuedId(this: void, conversation: string, stockId: string): string | undefined;
  openFile(this: void, id: string, path: string, line: number, col: number): void | Promise<void>;
}) {
  const scopes = new Map<string, Scope>();
  const sessions = new Map<string, StockSession>();
  const threadSessions = new WeakMap<StockSession, Map<string, ConversationSession>>();
  let active: { id: string; issueId?: string; leave: () => void } | undefined;
  let cancellation = 0;
  let latestCancellation = 0;
  let undo: UndoEntry | undefined;
  const unconfirmed = new Map<number, UndoEntry>();

  function confirmCancellation(entry: UndoEntry) {
    if (entry.order <= latestCancellation) return;
    latestCancellation = entry.order;
    undo = entry;
    for (const order of unconfirmed.keys())
      if (order <= latestCancellation) unconfirmed.delete(order);
  }

  const session = (id: string) => {
    let value = sessions.get(id);
    if (!value) {
      value = new StockSession(id, api, controller);
      sessions.set(id, value);
    }
    return value;
  };
  const route = () => parseRoute(controller.options.url ?? "/");
  const onIssue = (route: ReturnType<typeof parseRoute>) =>
    active?.issueId !== undefined &&
    route.kind === "issue" &&
    route.id === active.issueId &&
    route.view !== "edit";
  const current = () => {
    const value = route();
    const scope =
      onIssue(value) && active
        ? scopes.get(active.id)
        : value.kind === "conversation" && value.id
          ? (lookup?.(value.id) ?? scopes.get(value.id))
          : undefined;
    return scope && active?.id === scope.id ? { stock: session(scope.id), scope } : undefined;
  };
  const context = () => {
    const value = current();
    if (!value) controller.notify("会話を開いてから使えます");
    return value;
  };

  function matching(source: StockSession, message?: ServerMessage) {
    if (!message || message.type === "resync") void source.load();
    else if (message.type === "changed") {
      const parts = message.payload.parts;
      if (!parts || parts.includes("stock")) void source.load("stock");
      if (!parts || parts.includes("threads")) {
        void source.load("threads");
        if (parts && !parts.includes("stock")) void source.load("stock");
      }
    }
  }

  function leave() {
    const previous = active;
    active = undefined;
    previous?.leave();
  }

  function enter(value: Scope, issueId?: string) {
    scopes.set(value.id, value);
    if (active?.id === value.id && active.issueId === issueId) return;
    leave();
    const store = session(value.id);
    let previous: string | undefined;
    let clear: (() => void) | undefined;
    const status = () => {
      const items = store.snapshot().items.filter((item) => item.state === "stocked");
      const instructions = items.filter((item) => item.kind === "instruction").length;
      const next = `ストック 指示 ${instructions} / 質問 ${items.length - instructions}`;
      if (next === previous) return;
      previous = next;
      clear?.();
      clear = controller.registerStatusItem("stock", next);
    };
    const stopReceiving = subscribe(`conversation:${value.id}`, (message) =>
      matching(store, message),
    );
    const stopStatus = store.subscribe(status);
    active = {
      id: value.id,
      issueId,
      leave: () => {
        stopReceiving();
        stopStatus();
        clear?.();
      },
    };
    status();
    void store.load();
  }

  function enterIssue(value: Scope, issueId: string) {
    enter(value, issueId);
    const entered = active;
    return () => {
      if (active === entered) leave();
    };
  }

  function scopeSource(view: string) {
    if (view === "conversation") return conversationSource;
    if (view === "file" || view === "markdown-file") {
      const file = new URLSearchParams(route().query).get("path");
      const scope = current()?.scope;
      if (file && scope?.cwd) {
        const path = relativeFilePath(file, scope.cwd) ?? file;
        return (lines: Parameters<typeof fileSource>[1]) => fileSource(path, lines);
      }
    }
  }

  function marks(ctx: ActionContext, stock: StockSession): ReadonlyMap<number, StockMark> {
    const lines = controller.windowLines(ctx.window);
    if (ctx.view === designView) return designMarks(stock, lines);
    const source = scopeSource(ctx.view);
    return source ? stock.marks(source, lines) : new Map();
  }

  function markedItem(ctx: ActionContext, stock: StockSession) {
    const mark = marks(ctx, stock).get(ctx.line);
    return mark && "item" in mark ? mark.item : undefined;
  }

  function openList(stock: StockSession, item?: string) {
    if (item) stock.setPlacement(item);
    controller.openRight({ view: stockView, target: stock.id });
  }
  const openThread = (id: string) => {
    const value = current();
    if (value) controller.openRight({ view: "thread", target: id, parent: value.stock.id });
  };

  function compose(kind: StockItem["kind"], ctx: ActionContext) {
    const value = context();
    if (!value) return;
    const { stock, scope } = value;
    const previous = ctx.selection ? undefined : markedItem(ctx, stock);
    if (previous?.state === "stocked") {
      stock.compose(previous.kind, scope.title, previous.quote, previous);
      return;
    }
    const lines = controller.windowLines(ctx.window);
    const selection = ctx.selection ?? {
      mode: "line" as const,
      ranges: [{ line: ctx.line, from: 0, to: lines[ctx.line]?.text.length ?? 0 }],
    };
    const designPath =
      ctx.view === designView
        ? selection.ranges
            .map(({ line }) => lines[line]?.designDiff)
            .find((entry) => entry?.newNo !== undefined)?.path
        : undefined;
    const source = designPath ? designSource(designPath, lines) : scopeSource(ctx.view)?.(lines);
    const quote =
      source &&
      makeQuote(
        source,
        lines.map((line) => line.text),
        selection,
      );
    if (!quote) return controller.notify("この行には質問と指示を付けられません");
    if (Array.from(quote.text).length > 20_000)
      return controller.notify("選んだ範囲が長すぎます。20,000 文字以内で選んでください", "error");
    stock.compose(kind, scope.title, quote);
  }

  async function jump(scope: Scope, quote: Quote) {
    const value = route();
    const place = controller.context();
    if (quote.kind === "terminal") {
      controller.notify("ターミナルの出力の引用は、移る先がありません");
      return;
    }
    if (quote.kind === "file") {
      await openFile(scope.id, quote.path, quote.start.line, quote.start.col);
      return;
    }
    controller.pushJump(place.window, place.line);
    controller.focus("main");
    if (quote.kind === "conversation") {
      if (
        value.id === scope.id &&
        !value.view &&
        controller.placeRecord("main", quote.start.seq, quote.start.line, quote.start.col)
      )
        return;
      await controller.navigate(
        routeUrl({
          kind: "conversation",
          id: scope.id,
          query: new URLSearchParams({
            seq: String(quote.start.seq),
            quoteLine: String(quote.start.line),
            quoteColumn: String(quote.start.col),
          }).toString(),
        }),
        env.id(),
      );
    } else if (scope.issueId) {
      await controller.navigate(
        routeUrl({
          kind: "issue",
          id: scope.issueId,
          view: quote.kind === "design_diff" ? "design" : "pr",
          query: new URLSearchParams({
            path: quote.path,
            line: String(quote.start.line),
            col: String(quote.start.col),
            ...(quote.kind === "design_diff"
              ? {
                  quote: quote.text.split("\n", 1)[0],
                  ...(quote.start.row
                    ? {
                        quoteSide: quote.start.row.side,
                        quoteRow: String(quote.start.row.line),
                      }
                    : {}),
                  ...(quote.mode === "block" ? { quoteBlockEnd: String(quote.end.col) } : {}),
                }
              : {}),
          }).toString(),
        }),
      );
    }
  }

  function openMarked(ctx: ActionContext): boolean {
    const value = current();
    if (!value) return false;
    const { stock, scope } = value;
    const item = markedItem(ctx, stock);
    if (!item) return false;
    if (item.state === "stocked") openList(stock, item.id);
    else if (item.kind === "question" && item.thread) {
      if (controller.right.current?.view !== threadListView) {
        controller.openRight({ view: threadListView, target: stock.id });
      }
      openThread(item.thread.id);
    } else if (item.sentSeq !== null) {
      void jump(scope, {
        kind: "conversation",
        mode: "line",
        text: item.text,
        start: { seq: item.sentSeq, line: 0, col: 0 },
        end: { seq: item.sentSeq, line: 0, col: 0 },
      });
    } else {
      const place = controller.context();
      controller.pushJump(place.window, place.line);
      controller.focus("main");
      if (route().id === scope.id && !route().view) {
        const lines = controller.windowLines("main");
        const id = queuedId(scope.id, item.id);
        const line = lines.findIndex(
          (entry) => entry.kind === "queued" && entry.id === `queue:${id}`,
        );
        controller.place("main", line < 0 ? Math.max(0, lines.length - 1) : line, 0);
      } else
        void controller.navigate(routeUrl({ kind: "conversation", id: scope.id, query: "tail=1" }));
    }
    return true;
  }

  function itemAt(ctx: ActionContext, stock: StockSession) {
    if (ctx.view !== stockView) return markedItem(ctx, stock);
    const id = controller.currentLine(ctx.window)?.id;
    return stock.snapshot().items.find((item) => item.id === id && item.state === "stocked");
  }

  function navigateMark(ctx: ActionContext, direction: number) {
    const value = current();
    if (!value) return;
    const entries = [...marks(ctx, value.stock)].sort(([a], [b]) => a - b);
    const seen = new Set<string>();
    const first = entries.filter(([, mark]) => {
      if (mark.symbol === "›" || seen.has(mark.item.id)) return false;
      seen.add(mark.item.id);
      return true;
    });
    if (!first.length) return controller.notify("この画面に質問・指示の印はありません");
    const next =
      direction > 0
        ? first.find(([line]) => line > ctx.line)
        : first.findLast(([line]) => line < ctx.line);
    if (next) {
      controller.pushJump(ctx.window, ctx.line);
      controller.place(ctx.window, next[0], 0);
    } else controller.notify("これより先に印はありません");
  }

  const register = (name: string, label: string, run: ActionDef["run"], views?: string[]) =>
    controller.actions.register({
      name,
      label,
      group: "質問と指示",
      where: views ? "会話・ファイル" : "会話を開いているとき",
      views,
      run,
    });

  function prepareThread() {
    const view = controller.right.current;
    const stock = current()?.stock;
    if (!stock || !view || !isThreadRight(view) || view.parent !== stock.id) return;
    const entries = threadSessions.get(stock) ?? new Map<string, ConversationSession>();
    threadSessions.set(stock, entries);
    if (!entries.has(view.target))
      entries.set(
        view.target,
        new ConversationSession(view.target, conversations, controller, env, {
          view: stockThreadView,
        }),
      );
  }

  function missingThread(id: string, parent: string) {
    const view = controller.right.current;
    if (view && isThreadRight(view) && view.target === id && view.parent === parent)
      controller.closeRight();
  }

  function start() {
    const stopRoute = controller.subscribe(() => {
      const value = route();
      if (active && !onIssue(value) && (value.kind !== "conversation" || value.id !== active.id))
        leave();
      prepareThread();
    });
    const oldOpen = controller.options.openMarked;
    const open = (ctx: ActionContext) => openMarked(ctx) || oldOpen?.(ctx) || false;
    controller.options.openMarked = open;
    const remove = [
      register("stock.question", "箇所に質問を書く", (ctx) => compose("question", ctx), quoteViews),
      register(
        "stock.instruct",
        "箇所に指示を書く",
        (ctx) => compose("instruction", ctx),
        quoteViews,
      ),
      register("stock.list", "ストックの一覧", () => {
        const value = context();
        if (value) openList(value.stock);
      }),
      register("thread.list", "スレッドの一覧", () => {
        const value = context();
        if (value) controller.openRight({ view: threadListView, target: value.stock.id });
      }),
      ...(["all", "questions", "instructions"] as const).map((kind) =>
        register(
          `stock.send.${kind}`,
          {
            all: "全部送る",
            questions: "質問だけ送る",
            instructions: "指示だけ送る",
          }[kind],
          () => {
            const value = context();
            return value?.stock.send(value.scope.title, kind);
          },
        ),
      ),
      register("mark.next", "次の印へ", (ctx) => navigateMark(ctx, 1), quoteViews),
      register("mark.prev", "前の印へ", (ctx) => navigateMark(ctx, -1), quoteViews),
      controller.registerActionInterceptor("item.edit", {
        views: undoViews,
        run(ctx) {
          const value = current();
          const item = value && itemAt(ctx, value.stock);
          if (!item || item.state !== "stocked") return false;
          value.stock.compose(item.kind, value.scope.title, item.quote, item);
          return true;
        },
      }),
      controller.registerActionInterceptor("item.delete", {
        views: undoViews,
        async run(ctx) {
          const value = current();
          const item = value && itemAt(ctx, value.stock);
          if (!item || item.state !== "stocked") return false;
          const entry = {
            order: ++cancellation,
            stock: value.stock,
            id: item.id,
            waiting: true,
            restoring: false,
          };
          unconfirmed.set(entry.order, entry);
          try {
            await value.stock.cancel(item);
            confirmCancellation(entry);
          } catch (error) {
            if (definitiveCancelFailure(error)) unconfirmed.delete(entry.order);
            throw error;
          } finally {
            entry.waiting = false;
          }
          return true;
        },
      }),
      controller.registerActionInterceptor("item.undo", {
        views: undoViews,
        async run() {
          const uncertain = [...unconfirmed.values()].at(-1);
          if (uncertain) {
            controller.notify(
              uncertain.waiting
                ? "取り消しの結果を確認してから u で戻せます"
                : "このタブで取り消したことを確認できないため、戻せません",
            );
            return true;
          }
          const entry = undo;
          if (!entry) return false;
          if (entry.restoring) return true;
          entry.restoring = true;
          try {
            await entry.stock.restore(entry.id);
            if (undo === entry) undo = undefined;
            return true;
          } finally {
            entry.restoring = false;
          }
        },
      }),
    ];
    return () => {
      stopRoute();
      leave();
      remove.forEach((dispose) => dispose());
      if (controller.options.openMarked === open) controller.options.openMarked = oldOpen;
    };
  }

  const jumpItem = (item: StockItem) => {
    const scope = scopes.get(item.conversationId);
    if (scope) return jump(scope, item.quote);
  };
  const jumpThread = (quote: Quote) => {
    const value = current();
    if (value) return jump(value.scope, quote);
  };
  const finishThread = () => {
    const value = current();
    if (value) openList(value.stock);
  };
  const pickThread = (thread: { id: string }) => openThread(thread.id);
  return {
    start,
    enter,
    enterIssue,
    leave,
    session,
    right(view: RightView) {
      const value = current();
      if (!value) return null;
      const { stock, scope } = value;
      if (view.view === stockView)
        return <StockWindow stock={stock} title={scope.title} jump={jumpItem} />;
      if (view.view === threadListView)
        return <ThreadList stock={stock} title={scope.title} open={pickThread} />;
      if (isThreadRight(view) && view.parent === stock.id) {
        const thread = threadSessions.get(stock)?.get(view.target);
        if (!thread) return null;
        return (
          <ThreadWindow
            key={`${stock.id}:${view.target}`}
            session={thread}
            id={view.target}
            stock={stock}
            parentTitle={scope.title}
            controller={controller}
            conversations={conversations}
            subscribe={subscribe}
            showConversation={showConversation}
            jump={jumpThread}
            finished={finishThread}
            missing={missingThread}
          />
        );
      }
      return null;
    },
  };
}
