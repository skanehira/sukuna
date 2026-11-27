import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { StrictMode } from "react";
import { SWRConfig } from "swr";
import { App } from "../../App";
import { createNavigation } from "../../shell/navigation";
import type { RealtimeSocket } from "../../lib/realtime";
import { BufferController } from "../../buffer/controller";
import { createBrowserController } from "../../lib/browser";
import { inboxFixture, response, row } from "../../lib/inbox.test-support";
import { InboxPage } from "../inbox";
import { Tree } from "../../components/tree";
import { Layout } from "../../buffer/Layout";
import { ConversationSession } from "../../lib/conversation/session";
import { ConversationApiError, createConversationApi } from "../../lib/conversation/api";
import type { ConversationApi, Event, Snapshot } from "../../lib/conversation/types";
import { ConversationPage } from "./ConversationPage";
import { createConversationWorkspace } from "../../lib/conversation/workspace";

const snapshot: Snapshot = {
  conversation: {
    id: "c1",
    projectId: "p1",
    projectName: "project",
    title: "予約 API",
    kind: "chat",
    issueId: null,
    parentConversationId: null,
    cwd: "/project",
    worktree: null,
    runState: "idle",
    stopReason: null,
    resetsAt: null,
    lastSeq: 0,
    lastReadSeq: 0,
    lastPosition: null,
    closedAt: null,
  },
  draft: null,
  queue: [],
  pendingAnswers: null,
  pendingPermission: null,
  commands: [
    { name: "/dev-spec", description: "設計を進める\n詳細" },
    { name: "/review", description: "レビューする" },
  ],
};
const question: Event = {
  seq: 1,
  createdAt: 0,
  type: "question",
  payload: {
    request_id: "q1",
    questions: [
      {
        question: "戻す方法は?",
        header: "方法",
        multi_select: false,
        options: [
          { label: "A", description: "定期処理" },
          { label: "B", description: "次の処理" },
        ],
      },
      {
        question: "設定で変える?",
        header: "設定",
        multi_select: false,
        options: [{ label: "はい", description: "変えられる" }],
      },
    ],
  },
};
function fakeApi(overrides: Partial<ConversationApi> = {}): ConversationApi {
  return {
    get: async () => structuredClone(snapshot),
    events: async () => ({ events: [], lastSeq: 0, hasMore: false }),
    projects: async () => [],
    start: async () => ({ conversation: snapshot.conversation }),
    send: vi.fn<ConversationApi["send"]>(async () => ({ result: "delivered", queueItem: null })),
    saveDraft: vi.fn(async (_id, body) => ({
      draft: {
        text: body.text,
        images: body.images,
        updatedAt: body.editedAt,
        updatedBy: body.clientId,
      },
      applied: true,
    })),
    saveAnswers: vi.fn(async (_id, questionSeq, answers) => ({
      pendingAnswers: { questionSeq, answers },
    })),
    sendAnswers: vi.fn(async () => ({})),
    permission: async () => ({}),
    stop: async () => ({}),
    resume: async () => ({}),
    editQueue: async () => ({}),
    deleteQueue: vi.fn(async () => {}),
    sendStock: vi.fn(async () => ({})),
    upload: async () => ({ image: { id: "image-1" } }),
    ...overrides,
  };
}
async function mount(api = fakeApi(), events: Event[] = []) {
  const controller = new BufferController({ url: "/conversations/c1" });
  const session = new ConversationSession("c1", api, controller, {
    clientId: "tab",
    id: () => "message-id",
    now: () => 1000,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });
  await session.load();
  events.forEach((event) => session.receiveEvent(event));
  render(<Layout controller={controller} main={<ConversationPage session={session} />} />);
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  return { session, api, controller };
}
function prompt(): EditorView {
  return EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
}

const navigationTestTimeout = 15_000;

it.each([
  [true, "fresh", true, "即応", "移動なし"],
  [false, "fresh", false, "即応", "移動なし"],
  [true, "fresh", true, "取得失敗", "移動なし"],
  [true, "cached", true, "即応", "移動なし"],
  [false, "cached", false, "即応", "移動なし"],
  [true, "ordinary", true, "即応", "移動なし"],
  [false, "ordinary", false, "即応", "移動なし"],
  [false, "cached", true, "即応", "移動なし"],
  [false, "cached", true, "保留", "ツリーを選択"],
  [false, "cached", true, "保留", "3G"],
  [false, "cached", true, "保留", "Ctrl+o"],
  [false, "cached", true, "保留", "離脱して再訪"],
  [true, "cached", false, "保留", "移動なし"],
  [false, "cached", true, "取得失敗", "移動なし"],
] as const)(
  "tail指定の初回working=%s・再表示=%s・再表示時working=%s・取得=%s (%s)",
  async (initialWorking, revisit, reopenWorking, response, action) => {
    const events: Event[] = [
      {
        seq: 1,
        createdAt: 0,
        type: "assistant_text",
        payload: { text: "最初の行\n途中の行\n最後の行", parent_tool_use_id: null },
      },
    ];
    let working = initialWorking;
    let releaseGet = () => {};
    const reopenedGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let nextResponse: typeof response = revisit === "fresh" ? response : "即応";
    const statesRead: Snapshot["conversation"]["runState"][] = [];
    const get = vi.fn(async (): Promise<Snapshot> => {
      const runState = working ? "working" : "idle";
      const result = nextResponse;
      nextResponse = "即応";
      if (result === "保留") await reopenedGet;
      if (result === "取得失敗")
        throw new ConversationApiError(0, "network_error", "会話を取得できませんでした");
      statesRead.push(runState);
      return {
        ...structuredClone(snapshot),
        conversation: { ...snapshot.conversation, runState, lastSeq: events.length },
      };
    });
    const api = fakeApi({
      get,
      events: async (_id, after) => ({
        events: events.filter((event) => event.seq > after),
        lastSeq: events.length,
        hasMore: false,
      }),
    });
    const navigation = createNavigation({ kind: "home" }, () => {});
    const controller = new BufferController({ navigate: navigation.navigate });
    const socket: RealtimeSocket = {
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
      send: () => {},
      close: () => {},
    };
    let reportConnectionLoss = () => {};
    const workspace = createConversationWorkspace(
      api,
      controller,
      {
        clientId: "tab",
        id: () => "id",
        now: () => 0,
        schedule: (fn, ms) => {
          if (ms === 3000) reportConnectionLoss = fn;
          return () => {};
        },
      },
      () => socket,
    );
    const stop = workspace.start();
    socket.onopen?.();
    const mounted = render(
      <StrictMode>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>
          <App
            controller={controller}
            navigation={navigation}
            loadScreen={workspace.loadScreen}
            connection={workspace.connection}
          />
        </SWRConfig>
      </StrictMode>,
    );
    const open = async (url: string) => {
      await act(async () => controller.navigate(url));
      await screen.findByText("最後の行", { exact: true });
      await flush();
    };
    const home = async () => {
      await act(async () => controller.navigate("/"));
      await flush();
    };
    try {
      if (revisit === "fresh" && response === "取得失敗") {
        await act(async () => controller.navigate("/conversations/c1?tail=1"));
        expect(await screen.findByRole("alert")).toHaveTextContent("会話を取得できませんでした");
        expect(statesRead).toEqual([]);
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
        });
        await screen.findByText("最後の行", { exact: true });
        await flush();
      } else {
        await open("/conversations/c1?tail=1");
      }
      expect(statesRead).toEqual([initialWorking ? "working" : "idle"]);
      expect(controller.currentLine()?.text).toBe(initialWorking ? "最後の行" : "最初の行");
      if (revisit === "fresh" && initialWorking) {
        await act(async () => controller.jumpBack());
        expect(controller.currentLine()?.text).toBe("最後の行");
      }
      if (revisit !== "fresh") {
        act(() => main().dispatch({ selection: { anchor: main().state.doc.line(2).from } }));
        await home();
        if (revisit === "ordinary") {
          await open("/conversations/c1");
          act(() => main().dispatch({ selection: { anchor: main().state.doc.line(2).from } }));
          await home();
        }
        const readCount = statesRead.length;
        working = reopenWorking;
        nextResponse = response;
        if (response === "保留") {
          await act(async () => controller.navigate("/conversations/c1?tail=1"));
          await flush();
          expect(screen.getByRole("status", { name: "読み込み中" })).toBeVisible();
          expect(statesRead).toHaveLength(readCount);
          expect(screen.queryByRole("region", { name: "会話: 予約 API" })).not.toBeInTheDocument();
          const tree = EditorView.findFromDOM(
            screen.getByRole("region", { name: "sukuna" }).querySelector(".cm-editor")!,
          )!;
          if (action === "ツリーを選択") act(() => tree.focus());
          if (action === "離脱して再訪") {
            await home();
            working = false;
            await open("/conversations/c1?tail=1");
            expect(controller.currentLine()?.text).toBe("最初の行");
          }
          await act(async () => releaseGet());
          await screen.findByText("最後の行", { exact: true });
          await flush();
          if (action === "ツリーを選択") {
            expect({ hasFocus: tree.hasFocus, active: controller.snapshot().active }).toEqual({
              hasFocus: true,
              active: "tree",
            });
            act(() => controller.focus("main"));
          }
        } else {
          await open("/conversations/c1?tail=1");
        }
        if (response === "取得失敗") {
          expect(
            await screen.findByText("会話を取得できませんでした", { exact: true }),
          ).toBeVisible();
          expect(statesRead).toHaveLength(readCount);
          expect(controller.currentLine()?.text).toBe("最初の行");
        } else if (action === "離脱して再訪") {
          expect(statesRead.slice(readCount)).toEqual(["idle", "working"]);
          expect(controller.currentLine()?.text).toBe("最初の行");
        } else {
          expect(statesRead.slice(readCount)).toEqual([reopenWorking ? "working" : "idle"]);
          expect(controller.currentLine()?.text).toBe(reopenWorking ? "最後の行" : "最初の行");
        }
      }
      if (action === "3G") {
        key(main(), "3");
        key(main(), "G", { shiftKey: true });
      } else if (action === "Ctrl+o") {
        controller.pushJump("main", 2);
        await act(async () => {
          key(main(), "o", { ctrlKey: true });
        });
      } else {
        act(() => main().dispatch({ selection: { anchor: main().state.doc.line(3).from } }));
      }
      expect(controller.currentLine()?.text).toBe("途中の行");
      const event: Event = {
        seq: 2,
        createdAt: 1,
        type: "assistant_text",
        payload: { text: "新しい出力", parent_tool_use_id: null },
      };
      events.push(event);
      await act(async () =>
        socket.onmessage?.({
          data: JSON.stringify({
            topic: "conversation:c1",
            seq: 2,
            type: "event",
            payload: {
              ...event,
              conversation_id: "c1",
              sdk_uuid: null,
              created_at: event.createdAt,
            },
          }),
        }),
      );
      await screen.findByText("新しい出力", { exact: true });
      await flush();
      expect(controller.currentLine()?.text).toBe("途中の行");
      if (revisit === "fresh" || response !== "取得失敗") {
        act(() => {
          socket.onclose?.();
          reportConnectionLoss();
        });
      }
      const count = get.mock.calls.length;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
      });
      await waitFor(() => expect(get).toHaveBeenCalledTimes(count + 1));
      await flush();
      expect(controller.currentLine()?.text).toBe("途中の行");
      if (revisit !== "fresh" && response === "取得失敗") {
        expect(statesRead.at(-1)).toBe("working");
        expect(
          screen.queryByText("会話を取得できませんでした", { exact: true }),
        ).not.toBeInTheDocument();
      }
    } finally {
      await act(async () => {
        mounted.unmount();
        stop();
        releaseGet();
      });
    }
  },
  navigationTestTimeout,
);
function main(): EditorView {
  return EditorView.findFromDOM(
    screen.getByRole("region", { name: "会話: 予約 API" }).querySelector(".cm-editor")!,
  )!;
}
const navigationRecords: Event[] = [
  {
    seq: 1,
    createdAt: 0,
    type: "assistant_text",
    payload: { text: "リンクより前の行", parent_tool_use_id: null },
  },
  {
    seq: 2,
    createdAt: 1,
    type: "tool_use",
    payload: {
      tool_use_id: "tool",
      name: "mcp__sukuna__issue_create",
      input: {},
      parent_tool_use_id: null,
    },
  },
  {
    seq: 3,
    createdAt: 2,
    type: "tool_result",
    payload: {
      tool_use_id: "tool",
      content: '{"issue":{"number":42}}',
      is_error: false,
      truncated: false,
      bytes: 23,
    },
  },
  {
    seq: 4,
    createdAt: 3,
    type: "assistant_text",
    payload: { text: "最後の行", parent_tool_use_id: null },
  },
];

it.each(["idle", "working"] as const)(
  "別画面で Ctrl+o を押すと %s の会話のリンク元へ戻り、再取得後も行を保つ",
  async (runState) => {
    const url = "/conversations/c1?tail=1";
    const records = navigationRecords;
    let release = () => {};
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = vi.fn(async (): Promise<Snapshot> => ({
      ...structuredClone(snapshot),
      conversation: { ...snapshot.conversation, runState, lastSeq: records.length },
    }));
    get.mockImplementationOnce(async () => ({
      ...structuredClone(snapshot),
      conversation: { ...snapshot.conversation, lastSeq: records.length },
    }));
    get.mockImplementationOnce(async () => {
      await delay;
      return {
        ...structuredClone(snapshot),
        conversation: { ...snapshot.conversation, runState, lastSeq: records.length },
      };
    });
    const api = fakeApi({
      get,
      events: async (_id, after) => ({
        events: records.filter((record) => record.seq > after),
        lastSeq: records.length,
        hasMore: false,
      }),
    });
    const navigation = createNavigation({ kind: "home" }, () => {});
    const controller = new BufferController({ navigate: navigation.navigate });
    const workspace = createConversationWorkspace(
      api,
      controller,
      { clientId: "tab", id: () => "id", now: () => 0, schedule: () => () => {} },
      () => {
        throw new Error("このテストでは配信へ接続しない");
      },
    );
    render(
      <StrictMode>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>
          <App
            controller={controller}
            navigation={navigation}
            loadScreen={workspace.loadScreen}
            connection={{ snapshot: () => false, subscribe: () => () => {} }}
          />
        </SWRConfig>
      </StrictMode>,
    );
    await act(() => controller.navigate(url));
    await screen.findByText("最後の行", { exact: true });
    await openLine("● issue_create()");
    expect(controller.options.url).toBe("/issues/42");
    const tree = EditorView.findFromDOM(
      screen.getByRole("region", { name: "sukuna" }).querySelector(".cm-editor")!,
    )!;
    act(() => tree.focus());
    await act(async () => key(tree, "o", { ctrlKey: true }));
    expect(await screen.findByRole("status", { name: "読み込み中" })).toBeVisible();
    expect(controller.options.url).toBe(url);
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => release());
    await screen.findByText("最後の行", { exact: true });
    await flush();
    expect(main().hasFocus).toBe(true);
    expect(controller.currentLine()?.text).toBe("● issue_create()");

    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await flush();
    expect(controller.currentLine()?.text).toBe("● issue_create()");
  },
  navigationTestTimeout,
);
it.each([
  ["一覧へ戻る", "通常表示より先", "working", "最後の行"],
  ["一覧へ戻る", "通常表示より後", "working", "最後の行"],
  ["同じURLを開く", "通常表示より後", "working", "最後の行"],
  ["Ctrl+oを続ける", "通常表示より後", "working", "最後の行"],
  ["ブラウザで戻って進む", "通常表示より後", "idle", "リンクより前の行"],
] as const)(
  "Ctrl+oの読み込み中に%sとき、元のGETが%sでも通常表示の位置を保つ (%s)",
  async (cancel, oldResponse, runState, expected) => {
    const url = "/conversations/c1?tail=1";
    const path = () => `${window.location.pathname}${window.location.search}`;
    const previousUrl = path();
    const previousState = window.history.state;
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    const navigation = createNavigation({ kind: "home" }, () => {});
    const { controller, dispose } = createBrowserController(window, navigation.open);
    const inboxTitle = "会話: 作業中の予約 API";
    const { store } = inboxFixture(
      response(
        row({
          id: "c1",
          key: "conversation:c1",
          title: inboxTitle,
          section: "working",
          reason: "working",
        }),
      ),
    );
    let releaseOldGet = () => {};
    const oldGet = new Promise<void>((resolve) => {
      releaseOldGet = resolve;
    });
    const completedGets: number[] = [];
    const get = vi.fn(async (): Promise<Snapshot> => {
      const index = get.mock.calls.length;
      if (index === 2) await oldGet;
      completedGets.push(index);
      return {
        ...structuredClone(snapshot),
        conversation: {
          ...snapshot.conversation,
          runState: index < 3 ? "idle" : runState,
          lastSeq: navigationRecords.length,
        },
      };
    });
    const workspace = createConversationWorkspace(
      fakeApi({
        get,
        events: async (_id, after) => ({
          events: navigationRecords.filter((record) => record.seq > after),
          lastSeq: navigationRecords.length,
          hasMore: false,
        }),
      }),
      controller,
      { clientId: "tab", id: () => "id", now: () => 0, schedule: () => () => {} },
      () => {
        throw new Error("このテストでは配信へ接続しない");
      },
    );
    const mounted = render(
      <StrictMode>
        <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>
          <App
            controller={controller}
            navigation={navigation}
            loadScreen={async (route) =>
              route.kind === "home"
                ? {
                    kind: "ready",
                    title: "一覧",
                    fullWindow: true,
                    content: <InboxPage store={store} controller={controller} />,
                  }
                : workspace.loadScreen(route)
            }
            renderTree={(route) => <Tree store={store} route={route} />}
          />
        </SWRConfig>
      </StrictMode>,
    );
    const editor = (name: string) =>
      EditorView.findFromDOM(screen.getByRole("region", { name }).querySelector(".cm-editor")!)!;
    const enterInboxRow = async () => {
      const row = await screen.findByText(inboxTitle, { exact: true });
      const view = editor("一覧");
      await act(async () => {
        view.dispatch({ selection: { anchor: view.posAtDOM(row) } });
        view.focus();
        fireEvent.keyDown(view.contentDOM, { key: "Enter" });
      });
      expect(path()).toBe(url);
    };
    try {
      await enterInboxRow();
      await screen.findByText("最後の行", { exact: true });
      await openLine("● issue_create()");
      expect(path()).toBe("/issues/42");
      await screen.findByRole("alert");
      const tree = editor("sukuna");
      await act(async () => {
        tree.focus();
        fireEvent.keyDown(tree.contentDOM, { key: "o", ctrlKey: true });
      });
      expect(await screen.findByRole("status", { name: "読み込み中" })).toBeVisible();
      expect(path()).toBe(url);
      expect(completedGets).toEqual([1]);
      expect(get).toHaveBeenCalledTimes(2);

      if (cancel === "一覧へ戻る") {
        const home = within(screen.getByRole("region", { name: "sukuna" })).getByText("一覧", {
          exact: true,
        });
        const line = tree.posAtDOM(home);
        await act(async () => {
          tree.dispatch({ selection: { anchor: line } });
          fireEvent.keyDown(tree.contentDOM, { key: "Enter" });
        });
        expect(path()).toBe("/");
        if (oldResponse === "通常表示より先") await act(async () => releaseOldGet());
        await enterInboxRow();
      } else if (cancel === "同じURLを開く") {
        await act(async () => controller.navigate(url));
        expect(path()).toBe(url);
      } else if (cancel === "Ctrl+oを続ける") {
        await act(async () => {
          fireEvent.keyDown(tree.contentDOM, { key: "o", ctrlKey: true });
        });
        expect(path()).toBe("/");
        await enterInboxRow();
      } else {
        const traverse = async (direction: "back" | "forward", expectedPath: string) => {
          await act(async () => {
            const changed = new Promise<void>((resolve) => {
              window.addEventListener("popstate", () => resolve(), { once: true });
            });
            window.history[direction]();
            await changed;
          });
          expect(path()).toBe(expectedPath);
        };
        await traverse("back", "/issues/42");
        await traverse("forward", url);
      }

      await screen.findByText("最後の行", { exact: true });
      const cursorLine = () => main().state.doc.lineAt(main().state.selection.main.head).text;
      expect(completedGets).toEqual(oldResponse === "通常表示より先" ? [1, 2, 3] : [1, 3]);
      expect(cursorLine()).toBe(expected);
      await act(async () => releaseOldGet());
      await flush();
      expect(completedGets).toEqual(oldResponse === "通常表示より先" ? [1, 2, 3] : [1, 3, 2]);
      expect(cursorLine()).toBe(expected);
    } finally {
      await act(async () => {
        mounted.unmount();
        dispose();
        store.dispose();
        releaseOldGet();
        window.history.replaceState(previousState, "", previousUrl);
        window.sessionStorage.clear();
      });
    }
  },
  navigationTestTimeout,
);

function key(view: EditorView, key: string, extra = {}) {
  act(() => {
    fireEvent.keyDown(view.contentDOM, { key, ...extra });
  });
}
async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
async function openLine(text: string) {
  await flush();
  const view = main();
  const line = Array.from({ length: view.state.doc.lines }, (_, i) =>
    view.state.doc.line(i + 1),
  ).find((line) => line.text === text || line.text.split("  ")[1] === text)!;
  expect(line).toBeDefined();
  act(() => view.dispatch({ selection: { anchor: line.from } }));
  key(view, "Enter");
  await flush();
}

describe("会話の画面", () => {
  it.each(
    [false, true].flatMap((closeFirst) => [false, true].map((saved) => ({ closeFirst, saved }))),
  )(
    "預けた指示の配達後も本文を保ち、明示的に送れる (先に閉じる: $closeFirst / 保存済み: $saved)",
    async ({ closeFirst, saved }) => {
      const data = structuredClone(snapshot);
      data.queue = [
        {
          id: "queued",
          text: "預けた本文",
          images: ["img-one"],
          position: 1,
          stockItemId: null,
          clientId: null,
          createdAt: 0,
        },
      ];
      const get = vi.fn(async () => structuredClone(data));
      const send = vi.fn<ConversationApi["send"]>(async () => ({
        result: "delivered",
        queueItem: null,
      }));
      const editQueue = vi.fn<ConversationApi["editQueue"]>(async () => {
        throw new ConversationApiError(404, "not_found", "預かった指示が見つかりません");
      });
      const api = fakeApi({ get, editQueue, send });
      const { controller, session } = await mount(api);
      act(() => main().dispatch({ selection: { anchor: 0 } }));
      await act(async () => controller.run("item.edit"));
      const input = () =>
        EditorView.findFromDOM(
          screen.getByRole("textbox", { name: controller.snapshot().prompt!.label }),
        )!;
      act(() =>
        input().dispatch({
          changes: { from: 0, to: input().state.doc.length, insert: "修正本文" },
        }),
      );
      if (saved)
        await act(async () => {
          await session.saveDraft();
        });
      if (closeFirst) {
        key(input(), "Escape");
        key(input(), "Escape");
        await flush();
      }
      data.queue = [];
      if (!closeFirst) {
        await act(async () => {
          expect(await controller.submitPrompt("修正本文")).toBe(false);
        });
        await flush();
        expect({
          gets: get.mock.calls.length,
          queue: main().state.doc.toString(),
          notice: controller.snapshot().notice,
          text: input().state.doc.toString(),
          images: controller.snapshot().prompt?.images,
          calls: send.mock.calls,
        }).toEqual({
          gets: 2,
          queue: "",
          notice: { message: "すでに届きました", kind: "error" },
          text: "修正本文",
          images: 1,
          calls: [],
        });
        key(input(), "Escape");
        key(input(), "Escape");
        await flush();
      }
      key(main(), "i");
      expect(prompt().state.doc.toString()).toBe("修正本文");
      await act(async () => {
        expect(await controller.submitPrompt("修正本文")).toBe(true);
      });
      expect(api.send).toHaveBeenCalledWith("c1", {
        text: "修正本文",
        images: ["img-one"],
        mode: "send",
        clientMessageId: "message-id",
      });
      expect(editQueue.mock.calls).toEqual(
        closeFirst ? [] : [["c1", "queued", { text: "修正本文", images: ["img-one"] }]],
      );
    },
  );
  it.each(
    ["send", "interrupt", "queue-edit", "queue-only"].flatMap((mode) =>
      [false, true].flatMap((imageOnly) =>
        [false, true].map((delayedGet) => ({ mode, imageOnly, delayedGet })),
      ),
    ),
  )(
    "$mode : 応答待ちに追記・画像を足しても未送信の版を残す (画像だけ: $imageOnly / 古いGET: $delayedGet)",
    async ({ mode, imageOnly, delayedGet }) => {
      let finish = () => {};
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const data = structuredClone(snapshot);
      data.draft = { text: "送る本文", images: ["img-one"], updatedAt: 10, updatedBy: "other" };
      data.queue = [
        {
          id: "queued",
          text: "送る本文",
          images: ["img-one"],
          position: 1,
          stockItemId: null,
          clientId: null,
          createdAt: 0,
        },
      ];
      const send = vi.fn<ConversationApi["send"]>(async (_id, body) => {
        if (body.text || body.images.length) data.draft = null;
        await pending;
        return { result: "delivered", queueItem: null };
      });
      const editQueue = vi.fn<ConversationApi["editQueue"]>(async () => {
        await pending;
        return {};
      });
      let releaseGet = () => {};
      const oldGet = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      let gets = 0;
      const api = fakeApi({
        get: async () => {
          const value = structuredClone(data);
          if (++gets === 2 && delayedGet) await oldGet;
          return value;
        },
        send,
        editQueue,
        saveDraft: async (_id, body) => {
          data.draft =
            body.text || body.images.length
              ? {
                  text: body.text,
                  images: body.images,
                  updatedAt: body.editedAt,
                  updatedBy: body.clientId,
                }
              : null;
          return { draft: data.draft, applied: true };
        },
      });
      const { controller, session } = await mount(api);
      let submission: Promise<unknown>;
      if (mode === "queue-only")
        act(() => {
          submission = controller.run("conversation.queue.send");
        });
      if (mode === "queue-edit") {
        const row = main().state.doc.line(1);
        act(() => main().dispatch({ selection: { anchor: row.from } }));
        await act(async () => controller.run("item.edit"));
      } else key(main(), "i");
      const view = EditorView.findFromDOM(
        screen.getByRole("textbox", { name: controller.snapshot().prompt!.label }),
      )!;
      if (mode !== "queue-only")
        act(() => {
          submission = controller.submitPrompt(view.state.doc.toString(), mode === "interrupt");
        });
      act(() => {
        if (delayedGet)
          session.receive({
            topic: "conversation:c1",
            seq: 0,
            type: "changed",
            payload: { parts: ["draft"] },
          });
        if (!imageOnly)
          view.dispatch({ changes: { from: view.state.doc.length, insert: "に追記" } });
        fireEvent.paste(view.contentDOM, {
          clipboardData: { files: [new File(["image"], "image.png", { type: "image/png" })] },
        });
      });
      await screen.findByText("画像 2 件 (送信時に一緒に送る)", { exact: true });
      await act(async () => {
        if (delayedGet) await session.saveDraft();
        finish();
        await submission;
      });
      await act(async () => {
        releaseGet();
        await oldGet;
      });
      expect({
        text: view.state.doc.toString(),
        images: controller.snapshot().prompt?.images,
        open: controller.snapshot().prompt !== null,
      }).toEqual({ text: imageOnly ? "送る本文" : "送る本文に追記", images: 2, open: true });
      if (mode === "queue-edit")
        expect(editQueue.mock.calls).toEqual([
          ["c1", "queued", { text: "送る本文", images: ["img-one"] }],
        ]);
      else
        expect(send.mock.calls).toEqual([
          [
            "c1",
            {
              text: mode === "queue-only" ? "" : "送る本文",
              images: mode === "queue-only" ? [] : ["img-one"],
              mode: mode === "interrupt" ? "interrupt" : "send",
              clientMessageId: "message-id",
            },
          ],
        ]);
      await act(async () => {
        await session.saveDraft();
      });
      expect(data.draft).toEqual({
        text: imageOnly ? "送る本文" : "送る本文に追記",
        images: ["img-one", "image-1"],
        updatedAt: (imageOnly ? 1000 : 1001) + (mode === "queue-edit" ? 1 : 0),
        updatedBy: "tab",
      });
      if (mode === "queue-edit") {
        await act(async () => {
          await controller.submitPrompt(view.state.doc.toString());
        });
        expect(editQueue.mock.calls).toEqual([
          ["c1", "queued", { text: "送る本文", images: ["img-one"] }],
          [
            "c1",
            "queued",
            { text: imageOnly ? "送る本文" : "送る本文に追記", images: ["img-one", "image-1"] },
          ],
        ]);
        expect(send.mock.calls).toEqual([]);
      }
    },
  );
  it("届く前の指示だけを送るときは通常の書きかけと画像を送らずに残す", async () => {
    const data = structuredClone(snapshot);
    data.draft = {
      text: "まだ送らない本文",
      images: ["draft-image"],
      updatedAt: 10,
      updatedBy: "other",
    };
    data.queue = [
      {
        id: "queued",
        text: "預けた本文",
        images: [],
        position: 1,
        stockItemId: null,
        clientId: null,
        createdAt: 0,
      },
    ];
    const api = fakeApi({ get: async () => structuredClone(data) });
    const { controller } = await mount(api);
    await act(async () => controller.run("conversation.queue.send"));
    expect(api.send).toHaveBeenCalledWith("c1", {
      text: "",
      images: [],
      mode: "send",
      clientMessageId: "message-id",
    });
    key(main(), "i");
    expect({
      text: prompt().state.doc.toString(),
      images: controller.snapshot().prompt?.images,
    }).toEqual({ text: "まだ送らない本文", images: 1 });
  });
  it("画像を貼ると件数を出し、指示の送信にアップロードした画像を含める", async () => {
    const { api } = await mount();
    key(main(), "i");
    act(() => {
      prompt().dispatch({ changes: { from: 0, insert: "この画像を確認して" } });
      fireEvent.paste(prompt().contentDOM, {
        clipboardData: { files: [new File(["image"], "image.png", { type: "image/png" })] },
      });
    });
    expect(
      await screen.findByText("画像 1 件 (送信時に一緒に送る)", { exact: true }),
    ).toBeInTheDocument();
    key(prompt(), "Escape");
    key(prompt(), "Enter");
    await flush();
    expect(api.send).toHaveBeenCalledWith("c1", {
      text: "この画像を確認して",
      images: ["image-1"],
      mode: "send",
      clientMessageId: "message-id",
    });
  });
  it.each(["create", "edit"] as const)(
    "25行を超える%sの差分はEnterで開き、zcで再び畳める",
    async (change) => {
      const diff: Event = {
        seq: 1,
        createdAt: 0,
        type: "diff",
        payload: {
          tool_use_id: "tool",
          path: "a.ts",
          change,
          content: Array.from({ length: 26 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
          hunks:
            change === "create"
              ? []
              : [
                  {
                    old_start: 1,
                    old_lines: 0,
                    new_start: 1,
                    new_lines: 26,
                    lines: Array.from({ length: 26 }, (_, index) => `+line ${index + 1}`),
                  },
                ],
          truncated: false,
        },
      };
      await mount(fakeApi(), [diff]);
      await openLine("残り 16 行 (Enter か zo で開く)");
      expect(main().state.doc.toString()).toBe(
        Array.from({ length: 26 }, (_, index) => `${index + 1} +line ${index + 1}`).join("\n"),
      );
      key(main(), "z");
      key(main(), "c");
      await flush();
      expect(main().state.doc.toString()).toBe(
        [
          ...Array.from({ length: 10 }, (_, index) => `${index + 1} +line ${index + 1}`),
          "1  残り 16 行 (Enter か zo で開く)  ",
        ].join("\n"),
      );
    },
  );
  it.each(["", "\nさらに指示"])(
    "届く前の指示の取消は書きかけへ追加し、u は戻した分だけを除く (追加編集: %s)",
    async (extra) => {
      const queued = {
        id: "queue-1",
        text: "後の指示",
        images: ["queued-image"],
        position: 1,
        stockItemId: null,
        clientId: null,
        createdAt: 0,
      };
      const api = fakeApi({
        get: async () => ({
          ...snapshot,
          draft: { text: "書きかけ", images: ["draft-image"], updatedAt: 10, updatedBy: "other" },
          queue: [queued],
        }),
      });
      const { controller } = await mount(api);
      const view = main();
      const row = Array.from({ length: view.state.doc.lines }, (_, i) =>
        view.state.doc.line(i + 1),
      ).find((line) => line.text === "届く前の指示: 後の指示")!;
      act(() => view.dispatch({ selection: { anchor: row.from } }));
      key(view, "d");
      key(view, "d");
      await flush();
      key(view, "i");
      expect(prompt().state.doc.toString()).toBe("書きかけ\n\n後の指示");
      if (extra)
        act(() =>
          prompt().dispatch({ changes: { from: prompt().state.doc.length, insert: extra } }),
        );
      key(prompt(), "Escape");
      key(prompt(), "Escape");
      await flush();
      key(view, "u");
      await flush();
      await waitFor(() =>
        expect(api.saveDraft).toHaveBeenLastCalledWith("c1", {
          text: `書きかけ${extra}`,
          images: ["draft-image"],
          clientId: "tab",
          editedAt: extra ? 1002 : 1001,
        }),
      );
      expect(api.send).toHaveBeenCalledWith("c1", {
        text: "後の指示",
        images: ["queued-image"],
        mode: "send",
        clientMessageId: "message-id",
      });
      expect(controller.snapshot().prompt).toBeNull();
    },
  );
  it.each([
    ["Read", { file_path: "/project/src/a.ts" }, "/conversations/c1/file?path=src%2Fa.ts&line=1"],
    ["mcp__sukuna__issue_get", { number: 42 }, "/issues/42"],
  ])("（US-014）%s の実行行で Enter を押すと対象を開く", async (name, input, url) => {
    const { controller } = await mount(fakeApi(), [
      {
        seq: 1,
        createdAt: 0,
        type: "tool_use",
        payload: { tool_use_id: "tool", name, input, parent_tool_use_id: null },
      },
    ]);
    const navigate = vi.fn();
    controller.options.navigate = navigate;
    key(main(), "Enter");
    await flush();
    expect(navigate).toHaveBeenCalledWith(url);
  });
  it("（US-025）i で入力を開き、Normal の Esc で閉じても書きかけが残り、Normal の Enter で送れる", async () => {
    const { api, controller } = await mount();
    key(main(), "i");
    act(() => prompt().dispatch({ changes: { from: 0, insert: "作業を頼む" } }));
    key(prompt(), "Escape");
    key(prompt(), "Escape");
    await flush();
    expect(api.saveDraft).toHaveBeenCalledWith("c1", {
      text: "作業を頼む",
      images: [],
      clientId: "tab",
      editedAt: 1000,
    });
    expect(controller.snapshot().notice).toEqual({
      message: "書きかけを残しました。i で続きを書けます",
      kind: "info",
    });
    key(main(), "i");
    expect(prompt().state.doc.toString()).toBe("作業を頼む");
    key(prompt(), "Escape");
    key(prompt(), "Enter");
    await flush();
    expect(api.send).toHaveBeenCalledWith("c1", {
      text: "作業を頼む",
      images: [],
      mode: "send",
      clientMessageId: "message-id",
    });
    expect(controller.snapshot().prompt).toBeNull();
  });
  it("（US-046）/ の候補は前方一致と説明の一行目で表示し、Tab で選んだスキルをそのまま送る", async () => {
    const { api } = await mount();
    key(main(), "i");
    act(() => prompt().dispatch({ changes: { from: 0, insert: "/de" } }));
    expect(screen.getByLabelText("スキルの候補").textContent).toBe(
      "/dev-spec 設計を進めるTab で選ぶ",
    );
    key(prompt(), "Tab");
    key(prompt(), "Escape");
    key(prompt(), "Enter");
    await flush();
    expect(api.send).toHaveBeenCalledWith("c1", {
      text: "/dev-spec ",
      images: [],
      mode: "send",
      clientMessageId: "message-id",
    });
  });
  it("（US-015）503 の送信失敗で本文と未送信の理由が入力欄に残る", async () => {
    const api = fakeApi({
      send: createConversationApi(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "runner_unavailable", message: "ランナーにつながりません" },
            }),
            { status: 503 },
          ),
      ).send,
    });
    await mount(api);
    key(main(), "i");
    act(() => prompt().dispatch({ changes: { from: 0, insert: "残す指示" } }));
    key(prompt(), "Escape");
    key(prompt(), "Enter");
    await flush();
    expect(prompt().state.doc.toString()).toBe("残す指示");
    expect(
      screen.getByText("未送信: ランナーにつながりません", { exact: true }),
    ).toBeInTheDocument();
  });
  it("（US-014）delta を末尾へ逐次追加し、保存した発言が届くと一度だけ表示し、番の終わりでも消す", async () => {
    const { session } = await mount();
    act(() => {
      session.receive({
        topic: "conversation:c1",
        seq: 0,
        type: "delta",
        payload: { text: "調べ" },
      });
      session.receive({
        topic: "conversation:c1",
        seq: 0,
        type: "delta",
        payload: { text: "ています" },
      });
    });
    await flush();
    expect(main().state.doc.toString()).toBe("AI\n調べています");
    act(() =>
      session.receiveEvent({
        seq: 1,
        createdAt: 0,
        type: "assistant_text",
        payload: { text: "調べました", parent_tool_use_id: null },
      }),
    );
    await flush();
    expect(main().state.doc.toString()).toBe("AI\n調べました");
    act(() => session.delta("続き"));
    await flush();
    expect(main().state.doc.toString()).toBe("AI\n調べました\nAI\n続き");
    act(() =>
      session.receiveEvent({
        seq: 2,
        createdAt: 0,
        type: "turn_end",
        payload: {
          subtype: "success",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          cost_usd: 0,
          duration_ms: 0,
          permission_denials: 0,
        },
      }),
    );
    await flush();
    expect(main().state.doc.toString()).toBe("AI\n調べました");
  });
  it("（US-016）選択は保存だけを行い、もう一度 Enter で外れ、未回答を残して送ると y の確認を出す", async () => {
    const { api, controller } = await mount(fakeApi(), [question]);
    await openLine("A");
    expect(api.saveAnswers).toHaveBeenLastCalledWith("c1", 1, {
      "0": { choices: ["A"], text: null },
    });
    expect(main().state.doc.line(2).text).toBe("1  A  ✓ 選んだ (まだ送っていない)");
    expect(api.sendAnswers).toHaveBeenCalledTimes(0);
    await openLine("A");
    expect(api.saveAnswers).toHaveBeenLastCalledWith("c1", 1, { "0": { choices: [], text: null } });
    await openLine("B");
    await openLine("回答をまとめて送る (1 / 2 件)");
    expect(screen.getByLabelText("操作の確認").textContent).toBe(
      "答えていない質問が 1 件あります。このまま送りますか? (y / n)",
    );
    key(main(), "y");
    await flush();
    expect(api.sendAnswers).toHaveBeenCalledWith("c1", true);
    expect(controller.snapshot().notice).toEqual({
      message: "回答 1 件を 1 通にまとめて送りました",
      kind: "info",
    });
  });
  it.each([null, "stock-1"])(
    "届く前の指示を dd で取り消し、u で同じ本文か同じストック %s を預け直す",
    async (stockItemId) => {
      const queued = {
        id: "queue-1",
        text: "後の指示",
        images: [],
        position: 1,
        stockItemId,
        clientId: null,
        createdAt: 0,
      };
      const api = fakeApi({ get: async () => ({ ...snapshot, queue: [queued] }) });
      const { controller } = await mount(api);
      const view = main();
      const row = Array.from({ length: view.state.doc.lines }, (_, i) =>
        view.state.doc.line(i + 1),
      ).find((line) => line.text === "届く前の指示: 後の指示")!;
      act(() => view.dispatch({ selection: { anchor: row.from } }));
      key(view, "d");
      key(view, "d");
      await flush();
      expect(api.deleteQueue).toHaveBeenCalledWith("c1", "queue-1");
      expect(controller.snapshot().notice).toEqual({
        message: "預けた指示を取り消しました。u で戻せます",
        kind: "info",
      });
      key(view, "u");
      await flush();
      if (stockItemId)
        expect(api.sendStock).toHaveBeenCalledWith("c1", {
          kinds: "instructions",
          stockIds: ["stock-1"],
        });
      else
        expect(api.send).toHaveBeenCalledWith("c1", {
          text: "後の指示",
          images: [],
          mode: "send",
          clientMessageId: "message-id",
        });
    },
  );
  it("ストックの取消後に u を押すと、その件だけを既存の一括送信APIで送り直す", async () => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    const sendStock = createConversationApi(async (url, init) => {
      requests.push({
        url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ instructions: { count: 1, delivery: "queued" }, questions: [] });
    }).sendStock;
    const queued = {
      id: "queue-1",
      text: "この指示だけを戻す",
      images: [],
      position: 1,
      stockItemId: "stock-1",
      clientId: null,
      createdAt: 0,
    };
    await mount(fakeApi({ get: async () => ({ ...snapshot, queue: [queued] }), sendStock }));
    const view = main();
    const row = Array.from({ length: view.state.doc.lines }, (_, i) =>
      view.state.doc.line(i + 1),
    ).find((line) => line.text === "届く前の指示: この指示だけを戻す")!;
    act(() => view.dispatch({ selection: { anchor: row.from } }));
    key(view, "d");
    key(view, "d");
    await flush();
    key(view, "u");
    await flush();
    expect(requests).toEqual([
      {
        url: "/api/conversations/c1/stock/send",
        method: "POST",
        body: { kinds: "instructions", stockIds: ["stock-1"] },
      },
    ]);
  });
});

it(
  "通常の会話購読で届くdelta一件を一度表示し、保存済みイベントへ重複せず置き換える",
  async () => {
    const controller = new BufferController({ url: "/conversations/c1" });
    const navigation = createNavigation({ kind: "conversation", id: "c1" }, () => {});
    const socket: RealtimeSocket = {
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
      send: () => {},
      close: () => {},
    };
    const settingsChanged = vi.fn<() => void>();
    const workspace = createConversationWorkspace(
      fakeApi(),
      controller,
      { clientId: "tab", id: () => "id", now: () => 0, schedule: () => () => {} },
      () => socket,
      { settingsChanged },
    );
    const stop = workspace.start();
    socket.onopen?.();
    const mounted = render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <App controller={controller} navigation={navigation} loadScreen={workspace.loadScreen} />
      </SWRConfig>,
    );
    const receive = async (message: unknown) => {
      act(() => socket.onmessage?.({ data: JSON.stringify(message) }));
      await flush();
    };
    const expected = "AI\n独立試験の途中出力";
    try {
      await screen.findByRole("region", { name: "会話: 予約 API" });
      await receive({
        topic: "conversation:c1",
        seq: 0,
        type: "delta",
        payload: { text: "独立試験の途中出力" },
      });
      await waitFor(() => expect(main().state.doc.lines).toBe(2));
      const interim = main().state.doc.toString();
      await receive({
        topic: "conversation:c1",
        seq: 1,
        type: "event",
        payload: {
          type: "assistant_text",
          payload: { text: "独立試験の途中出力", parent_tool_use_id: null },
          conversation_id: "c1",
          seq: 1,
          created_at: 1,
          sdk_uuid: null,
        },
      });
      await waitFor(() => expect(main().state.doc.toString()).toBe(expected));
      expect([interim, main().state.doc.toString()]).toEqual([expected, expected]);
      const before = settingsChanged.mock.calls.length;
      await receive({
        topic: "app",
        seq: 0,
        type: "settings_changed",
        payload: { keymap: "updated" },
      });
      expect(settingsChanged).toHaveBeenCalledTimes(before + 1);
    } finally {
      mounted.unmount();
      stop();
    }
  },
  navigationTestTimeout,
);
