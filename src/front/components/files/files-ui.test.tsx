import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { expect, test, vi } from "vite-plus/test";
import { App } from "../../App";
import { BufferController } from "../../buffer/controller";
import { ConversationApiError, createConversationApi } from "../../lib/conversation/api";
import type { Event, Snapshot } from "../../lib/conversation/types";
import { createConversationWorkspace } from "../../lib/conversation/workspace";
import type { FilesApi } from "../../lib/files/api";
import type { RealtimeSocket } from "../../lib/realtime";
import { parseRoute } from "../../lib/routes";
import { createNavigation } from "../../shell/navigation";

const data: Snapshot = {
  conversation: {
    id: "c1",
    title: "予約",
    cwd: "/fixture/shop",
    projectId: "p1",
    projectName: "shop",
    kind: "chat",
    issueId: null,
    parentConversationId: null,
    worktree: null,
    runState: "idle",
    stopReason: null,
    resetsAt: null,
    lastSeq: 1,
    lastReadSeq: 0,
    lastPosition: null,
    closedAt: null,
  },
  draft: null,
  queue: [],
  commands: [],
  pendingAnswers: null,
  pendingPermission: null,
};
const reply: Event = {
  type: "assistant_text",
  seq: 1,
  createdAt: 0,
  payload: {
    text: "最初の行です。\n詳しくは (`src/order.ts:2`) です。\n最後の行です。",
    parent_tool_use_id: null,
  },
};
const diff: Event = {
  type: "diff",
  seq: 2,
  createdAt: 10,
  payload: {
    tool_use_id: "t",
    path: "/fixture/shop/src/order.ts",
    change: "edit",
    hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ["-old", "+new"] }],
    truncated: true,
  },
};

function mount(
  overrides: Partial<FilesApi> = {},
  initial = "/conversations/c1",
  watchers: {
    child?: string;
    childUnavailable?: () => boolean;
    childSeq?: () => number;
    scheduled?: Set<() => void>;
  } = {},
) {
  const history: { url: string; entry?: string }[] = [{ url: initial }];
  const navigation = createNavigation(parseRoute(initial), () => {});
  const visit = (url: string, entry?: string) => navigation.open({ ...parseRoute(url), entry });
  const controller = new BufferController({
    url: initial,
    navigate: (url, entry?: string) => {
      history.push({ url, entry });
      visit(url, entry);
    },
    back: () => {
      if (history.length < 2) return false;
      history.pop();
      const current = history.at(-1)!;
      controller.changeScreen(current.url, current.entry);
      visit(current.url, current.entry);
      return true;
    },
  });
  const send = vi.fn<RealtimeSocket["send"]>();
  const socket: RealtimeSocket = {
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send,
    close: () => {},
  };
  const fixture = { ...data, conversation: { ...data.conversation, lastSeq: 2 } };
  const eventHistory = new Map<string, Event[]>([["c1", [reply, diff]]]);
  let lastSeq = fixture.conversation.lastSeq;
  const conversationApi = createConversationApi(async (input) => {
    const path =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (path.includes("/events")) {
      const url = new URL(path, "http://test");
      const id = url.pathname.split("/").at(-2)!;
      const events = eventHistory.get(id) ?? [];
      const after = Number(url.searchParams.get("after"));
      return Response.json({
        events: events.filter((event) => event.seq > after),
        lastSeq: events.at(-1)?.seq ?? 0,
        hasMore: false,
      });
    }
    if (watchers.child && path.endsWith(`/${watchers.child}`)) {
      if (watchers.childUnavailable?.())
        return Response.json(
          { error: { code: "unavailable", message: "再取得中" } },
          { status: 503 },
        );
      return Response.json({
        ...fixture,
        conversation: {
          ...fixture.conversation,
          id: watchers.child,
          parentConversationId: "c1",
          lastSeq: watchers.childSeq?.() ?? fixture.conversation.lastSeq,
        },
      });
    }
    return Response.json({ ...fixture, conversation: { ...fixture.conversation, lastSeq } });
  });
  let text = "const a = 1;\nconst b = 2;\n";
  const api: FilesApi = {
    list: vi.fn(async () => ({
      files: ["README.md", "src/order.ts"],
      changed: ["src/order.ts"],
      truncated: false,
    })),
    content: vi.fn<FilesApi["content"]>(async (_id, path) => ({
      path,
      kind: "text",
      size: 32,
      content: path.endsWith(".md")
        ? "# Intro\n\nA **bold** word.\n![diagram](https://fixture.test/p.png)"
        : text,
    })),
    search: vi.fn(async (_id, mode, query) =>
      mode === "content"
        ? {
            mode,
            query,
            matches: [{ path: "src/order.ts", line: 2, col: 6, text: "const b = 2;" }],
            timedOut: false,
            truncated: false,
          }
        : { mode, query, matches: [{ path: "src/order.ts" }], truncated: false },
    ),
    changes: async () => ({
      files: [
        {
          path: "src/order.ts",
          added: 1,
          removed: 1,
          changes: [
            {
              seq: 2,
              createdAt: 0,
              change: "edit",
              truncated: true,
              hunks: [
                {
                  oldStart: 7,
                  oldLines: 1,
                  newStart: 2,
                  newLines: 1,
                  lines: ["-before", "+after"],
                },
              ],
            },
          ],
        },
      ],
    }),
    threads: async () => [],
    ...overrides,
  };
  let reconnect: (() => void) | undefined;
  let nextId = 0;
  const workspace = createConversationWorkspace(
    conversationApi,
    controller,
    {
      clientId: "tab",
      id: () => `entry-${++nextId}`,
      now: () => 1,
      schedule: (fn, ms) => {
        if (ms === 1000 && watchers.scheduled) {
          const callbacks = watchers.scheduled;
          callbacks.add(fn);
          return () => callbacks.delete(fn);
        }
        if (ms === 500) {
          reconnect = fn;
          return () => {
            reconnect = undefined;
          };
        }
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    () => socket,
    { files: api },
  );
  const stop = workspace.start();
  socket.onopen?.();
  const mounted = render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <App
        controller={controller}
        navigation={navigation}
        loadScreen={workspace.loadScreen}
        renderRight={workspace.renderRight}
      />
    </SWRConfig>,
  );
  const close = () => {
    mounted.unmount();
    stop();
  };
  return {
    api,
    controller,
    socketMessages: () => send.mock.calls.map(([raw]) => JSON.parse(raw)),
    disconnect: () => act(() => socket.onclose?.()),
    reconnect: () =>
      act(() => {
        reconnect?.();
        socket.onopen?.();
      }),
    receive: (message: unknown) => act(() => socket.onmessage?.({ data: JSON.stringify(message) })),
    setLastSeq: (value: number) => {
      lastSeq = value;
    },
    record: (event: Event, id = "c1") => {
      eventHistory.set(
        id,
        [...(eventHistory.get(id) ?? []), event].sort((a, b) => a.seq - b.seq),
      );
    },
    close,
    url: () => history.at(-1)!.url,
    changeText: (value: string) => {
      text = value;
    },
    publish: (event: Event, id = "c1") =>
      act(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            topic: `conversation:${id}`,
            seq: event.seq,
            type: "event",
            payload: { ...event, conversation_id: id, sdk_uuid: null, created_at: event.createdAt },
          }),
        }),
      ),
  };
}

function key(view: EditorView, ...keys: string[]) {
  for (const key of keys)
    act(() => {
      fireEvent.keyDown(view.contentDOM, { key });
    });
}
function caret(view: EditorView) {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, column: head - line.from, text: line.text };
}
async function buffer(title: string | RegExp, text: string) {
  const region = await screen.findByRole("region", { name: title });
  return waitFor(() => {
    const editor = region.querySelector(".cm-editor");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor as HTMLElement)!;
    expect(view.state.doc.toString()).toContain(text);
    return view;
  });
}
function select(view: EditorView, text: string, inLine = "") {
  const line = Array.from({ length: view.state.doc.lines }, (_, i) =>
    view.state.doc.line(i + 1),
  ).find((line) => line.text.includes(text))!;
  act(() =>
    view.dispatch({ selection: { anchor: line.from + (inLine ? line.text.indexOf(inLine) : 0) } }),
  );
}

test("閉じたフォルダを開いてファイルを選ぶと、主に読み取り専用の本文が出る", async () => {
  const app = mount();
  try {
    const conversation = await buffer("会話: 予約", "詳しくは");
    key(conversation, " ", "e");
    const tree = await buffer("ファイル", "▸ src");
    expect(tree.state.doc.toString()).not.toContain("order.ts");
    select(tree, "▸ src");
    key(tree, "Enter");
    await waitFor(() => expect(tree.state.doc.toString()).toContain("order.ts"));
    select(tree, "order.ts");
    key(tree, "Enter");
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const a");
    expect(document.activeElement).toBe(file.contentDOM);
    expect(file.state.readOnly).toBe(true);
    key(file, "i", "x");
    expect(file.state.doc.toString()).toBe("const a = 1;\nconst b = 2;\n");
    key(file, " ", "e");
    await waitFor(() => expect(caret(tree).text).toContain("order.ts"));
    select(tree, "▾ src");
    key(tree, "z", "c");
    await waitFor(() => expect(tree.state.doc.toString()).not.toContain("order.ts"));
    expect(caret(tree).text).toContain("▸ src");
    key(tree, "z", "o");
    await waitFor(() => expect(tree.state.doc.toString()).toContain("order.ts"));
  } finally {
    app.close();
  }
});

test("回答のパスで gf を押すと指定行へ移り、戻ると元の行に戻る", async () => {
  const app = mount();
  try {
    const conversation = await buffer("会話: 予約", "詳しくは");
    select(conversation, "詳しくは", "src");
    key(conversation, "g", "f");
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b");
    expect(caret(file)).toMatchObject({ line: 2, text: "const b = 2;" });
    expect(app.api.content).toHaveBeenCalledTimes(1);
    key(file, "k");
    expect(caret(file).line).toBe(1);
    key(file, "-");
    const returned = await buffer("会話: 予約", "詳しくは");
    expect(caret(returned).text).toContain("詳しくは");
    select(returned, "詳しくは", "src");
    key(returned, "g", "f");
    const reopened = await buffer(/src\/order.ts.*読み取り専用/, "const b");
    expect(caret(reopened)).toMatchObject({ line: 2, text: "const b = 2;" });
  } finally {
    app.close();
  }
});

test("スレッド一覧を待つ間の変更は、後から取得した最新の本文に重ねて通知しない", async () => {
  let finish!: () => void;
  const listing = new Promise<[]>((resolve) => {
    finish = () => resolve([]);
  });
  const threads = vi.fn<FilesApi["threads"]>().mockResolvedValue([]);
  const app = mount({ threads });
  try {
    const conversation = await buffer("会話: 予約", "詳しくは");
    key(conversation, " ", "e");
    await buffer("ファイル", "▸ src");
    act(() => app.controller.focus("main"));
    threads.mockReturnValueOnce(listing);
    const previous = threads.mock.calls.length;
    select(conversation, "詳しくは", "src");
    key(conversation, "g", "f");
    await waitFor(() => expect(threads).toHaveBeenCalledTimes(previous + 1));
    expect(app.api.content).not.toHaveBeenCalled();
    const change = { ...diff, seq: 3 };
    app.record(change);
    app.setLastSeq(3);
    app.changeText("const a = 1;\nconst b = 3;");
    app.publish(change);
    await waitFor(() => expect(conversation.state.doc.toString().match(/1 -old/g)).toHaveLength(2));
    await act(async () => finish());
    await buffer(/src\/order.ts.*読み取り専用/, "const b = 3;");
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    expect(app.api.content).toHaveBeenCalledTimes(1);
  } finally {
    app.close();
  }
});

test("読取開始前に観測した番号までの差分は通知せず、開始後の差分は通知する", async () => {
  let finish!: () => void;
  const waiting = new Promise<[]>((resolve) => {
    finish = () => resolve([]);
  });
  const threads = vi.fn<FilesApi["threads"]>().mockResolvedValue([]);
  const app = mount({ threads });
  try {
    const conversation = await buffer("会話: 予約", "詳しくは");
    key(conversation, " ", "e");
    await buffer("ファイル", "▸ src");
    act(() => app.controller.focus("main"));
    threads.mockReturnValueOnce(waiting);
    const previous = threads.mock.calls.length;
    select(conversation, "詳しくは", "src");
    key(conversation, "g", "f");
    await waitFor(() => expect(threads).toHaveBeenCalledTimes(previous + 1));
    app.changeText("const a = 1;\nconst b = 4;");
    const alreadyRead = { ...diff, seq: 4 };
    app.record(alreadyRead);
    app.publish(alreadyRead);
    await act(async () => finish());
    await buffer(/src\/order.ts.*読み取り専用/, "const b = 4;");
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    app.record({ ...diff, seq: 3 });
    await act(async () => {
      app.receive({ type: "resync", topic: "conversation:c1", seq: 4, payload: { last_seq: 4 } });
    });
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    const later = { ...diff, seq: 5 };
    app.record(later);
    app.publish(later);
    expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
    expect(app.api.content).toHaveBeenCalledTimes(1);
  } finally {
    app.close();
  }
});

test("既存のスレッドの状態が一時取得できなくても、反映済みの変更を通知しない", async () => {
  let unavailable = false;
  const app = mount({ threads: async () => [arrivingThread] }, "/conversations/c1", {
    child: "child",
    childUnavailable: () => unavailable,
  });
  try {
    app.record(diff, "child");
    const conversation = await buffer("会話: 予約", "詳しくは");
    key(conversation, " ", "e");
    await buffer("ファイル", "▸ src");
    await waitFor(() =>
      expect(app.socketMessages()).toContainEqual({
        op: "subscribe",
        topic: "conversation:child",
        after: 2,
      }),
    );
    act(() => app.controller.focus("main"));
    unavailable = true;
    select(conversation, "詳しくは", "src");
    key(conversation, "g", "f");
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b = 2;");
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    app.publish({ ...diff, seq: 3 }, "child");
    expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
    expect(file.state.doc.toString()).toContain("const b = 2;");
    expect(app.api.content).toHaveBeenCalledTimes(1);
  } finally {
    app.close();
  }
});

test("開始番号が不明な既存スレッドは、状態が戻ってから新しい差分を通知する", async () => {
  let unavailable = true;
  const app = mount(
    { threads: async () => [arrivingThread] },
    "/conversations/c1/file?path=src%2Forder.ts&line=2",
    { child: "child", childUnavailable: () => unavailable },
  );
  const subscriptions = () =>
    app
      .socketMessages()
      .filter((message) => message.op === "subscribe" && message.topic === "conversation:child");
  try {
    app.record(diff, "child");
    await buffer(/src\/order.ts.*読み取り専用/, "const b");
    expect(subscriptions()).toHaveLength(0);
    unavailable = false;
    app.receive({
      topic: "conversation:c1",
      type: "changed",
      seq: 2,
      payload: { parts: ["threads"] },
    });
    await waitFor(() =>
      expect(subscriptions()).toEqual([{ op: "subscribe", topic: "conversation:child", after: 2 }]),
    );
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    app.publish({ ...diff, seq: 3 }, "child");
    expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
  } finally {
    app.close();
  }
});

test.each([
  { unavailable: "状態", path: "src/order.ts" },
  { unavailable: "一覧", path: "src/order.ts" },
  { unavailable: "一覧", path: "src/other.ts" },
])(
  "スレッド$unavailable の復旧時は、開いているファイルの実際の変更だけ知らせる ($path)",
  async ({ unavailable, path }) => {
    let failed = true;
    let childSeq = 2;
    const app = mount(
      {
        threads: async () => {
          if (failed && unavailable === "一覧")
            throw new ConversationApiError(503, "runner_unavailable", "一時取得できません");
          return [arrivingThread];
        },
      },
      "/conversations/c1/file?path=src%2Forder.ts&line=2",
      {
        child: "child",
        childUnavailable: () => failed && unavailable === "状態",
        childSeq: () => childSeq,
      },
    );
    try {
      const file = await buffer(/src\/order.ts.*読み取り専用/, "const b = 2;");
      select(file, "const b", "b");
      expect(app.api.content).toHaveBeenCalledTimes(1);
      app.record({ ...diff, seq: 3, payload: { ...diff.payload, path } }, "child");
      childSeq = 3;
      if (path === "src/order.ts") app.changeText("const a = 1;\nconst b = 3;");
      failed = false;
      app.receive({
        type: "changed",
        topic: "conversation:c1",
        seq: 2,
        payload: { parts: ["threads"] },
      });
      await waitFor(() =>
        expect(app.socketMessages()).toContainEqual({
          op: "subscribe",
          topic: "conversation:child",
          after: 3,
        }),
      );
      if (path === "src/order.ts")
        expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
      else {
        await waitFor(() => expect(app.api.content).toHaveBeenCalledTimes(2));
        expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
      }
      expect(caret(file)).toEqual({ line: 2, column: 6, text: "const b = 2;" });
      if (path === "src/order.ts") {
        await act(() => app.controller.command(":e"));
        await waitFor(() => expect(file.state.doc.toString()).toContain("const b = 3;"));
        expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
      }
    } finally {
      app.close();
    }
  },
);

test.each([":e", "別のファイル"])("復旧時の内容比較は %s を選ぶと中止する", async (destination) => {
  let failed = true;
  let finish!: (result: Awaited<ReturnType<FilesApi["content"]>>) => void;
  const comparison = new Promise<Awaited<ReturnType<FilesApi["content"]>>>((resolve) => {
    finish = resolve;
  });
  const content = vi
    .fn<FilesApi["content"]>()
    .mockResolvedValueOnce({
      path: "src/order.ts",
      kind: "text",
      size: 25,
      content: "const a = 1;\nconst b = 2;",
    })
    .mockReturnValueOnce(comparison)
    .mockImplementation(async (_id, path) => ({
      path,
      kind: "text",
      size: 25,
      content: path.endsWith(".md") ? "# 次のファイル" : "const a = 1;\nconst b = 3;",
    }));
  const app = mount(
    { content, threads: async () => [arrivingThread] },
    "/conversations/c1/file?path=src%2Forder.ts&line=2",
    { child: "child", childUnavailable: () => failed },
  );
  try {
    await buffer(/src\/order.ts.*読み取り専用/, "const b = 2;");
    failed = false;
    app.receive({
      type: "changed",
      topic: "conversation:c1",
      seq: 2,
      payload: { parts: ["threads"] },
    });
    await waitFor(() => expect(content).toHaveBeenCalledTimes(2));
    if (destination === ":e") {
      await act(() => app.controller.command(":e"));
      await buffer(/src\/order.ts.*読み取り専用/, "const b = 3;");
    } else {
      await act(() => app.controller.navigate("/conversations/c1/file?path=README.md"));
      await buffer(/README.md.*読み取り専用/, "次のファイル");
    }
    expect(content.mock.calls[1][2]?.aborted).toBe(true);
    await act(async () =>
      finish({
        path: "src/order.ts",
        kind: "text",
        size: 25,
        content: "const a = 1;\nconst b = 4;",
      }),
    );
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    expect(content).toHaveBeenCalledTimes(3);
  } finally {
    app.close();
  }
});

test.each(["binary", "too_large"] as const)(
  "本文がない同じサイズの %s は、購読の復旧後も変更を確認できないと案内する",
  async (kind) => {
    let failed = true;
    const content = vi.fn<FilesApi["content"]>(async (_id, path) => ({
      kind,
      path,
      size: 1_048_577,
    }));
    const app = mount(
      { content, threads: async () => [arrivingThread] },
      "/conversations/c1/file?path=src%2Forder.ts",
      { child: "child", childUnavailable: () => failed },
    );
    const unverified = /ファイルの変更を確認できませんでした。:e で読み直します/;
    try {
      const file = await buffer(/src\/order.ts.*読み取り専用/, "表示できません");
      expect(screen.queryByText(unverified)).toBeNull();
      failed = false;
      app.receive({
        type: "changed",
        topic: "conversation:c1",
        seq: 2,
        payload: { parts: ["threads"] },
      });
      expect(await screen.findByText(unverified)).toBeVisible();
      expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
      expect(file.state.doc.toString()).toContain("表示できません");
      expect(content).toHaveBeenCalledTimes(2);
      await act(() => app.controller.command(":e"));
      await waitFor(() => expect(content).toHaveBeenCalledTimes(3));
      expect(screen.queryByText(unverified)).toBeNull();
    } finally {
      app.close();
    }
  },
);

test("比較の503は未確認のまま再接続で1回やり直し、本文を変えず実際の変更を案内する", async () => {
  let failed = true;
  const old = {
    path: "src/order.ts",
    kind: "text" as const,
    size: 25,
    content: "const a = 1;\nconst b = 2;",
  };
  const latest = { ...old, content: "const a = 1;\nconst b = 3;" };
  const content = vi
    .fn<FilesApi["content"]>()
    .mockResolvedValueOnce(old)
    .mockRejectedValueOnce(
      new ConversationApiError(503, "runner_unavailable", "一時取得できません"),
    )
    .mockResolvedValue(latest);
  const app = mount(
    { content, threads: async () => [arrivingThread] },
    "/conversations/c1/file?path=src%2Forder.ts&line=2",
    { child: "child", childUnavailable: () => failed },
  );
  const unverified = /ファイルの変更を確認できませんでした。:e で読み直します/;
  try {
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b = 2;");
    select(file, "const b", "b");
    failed = false;
    app.receive({
      type: "changed",
      topic: "conversation:c1",
      seq: 2,
      payload: { parts: ["threads"] },
    });
    expect(await screen.findByText(unverified)).toBeVisible();
    expect(content).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    app.disconnect();
    app.reconnect();
    expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
    expect(screen.queryByText(unverified)).toBeNull();
    expect(caret(file)).toEqual({ line: 2, column: 6, text: "const b = 2;" });
    expect(content).toHaveBeenCalledTimes(3);
    await act(() => app.controller.command(":e"));
    await waitFor(() => expect(file.state.doc.toString()).toContain("const b = 3;"));
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    expect(content).toHaveBeenCalledTimes(4);
  } finally {
    app.close();
  }
});

test.each(["gf", "Enter"])(
  "右ツリーが先に受けた変更を %s で取得中のファイルにも引き継ぐ",
  async (keyName) => {
    let finish!: (value: Awaited<ReturnType<FilesApi["content"]>>) => void;
    const reading = new Promise<Awaited<ReturnType<FilesApi["content"]>>>((resolve) => {
      finish = resolve;
    });
    const content = vi
      .fn<FilesApi["content"]>()
      .mockReturnValueOnce(reading)
      .mockResolvedValue({ path: "src/order.ts", kind: "text", size: 12, content: "const b = 3;" });
    const fromThread = keyName === "Enter";
    const app = mount(
      { content, threads: async () => (fromThread ? [arrivingThread] : []) },
      "/conversations/c1",
      { child: "child" },
    );
    try {
      const conversation = await buffer("会話: 予約", "詳しくは");
      key(conversation, " ", "e");
      await buffer("ファイル", "▸ src");
      act(() => app.controller.focus("main"));
      if (fromThread) {
        await waitFor(() =>
          expect(app.socketMessages()).toContainEqual({
            op: "subscribe",
            topic: "conversation:child",
            after: 2,
          }),
        );
        const tool: Event = {
          type: "tool_use",
          seq: 3,
          createdAt: 1,
          payload: {
            tool_use_id: "read",
            name: "Read",
            input: { file_path: "src/order.ts" },
            parent_tool_use_id: null,
          },
        };
        app.record(tool);
        app.setLastSeq(3);
        app.publish(tool);
        await waitFor(() =>
          expect(conversation.state.doc.toString()).toContain("● Read(src/order.ts)"),
        );
        select(conversation, "● Read(src/order.ts)");
        key(conversation, "Enter");
      } else {
        select(conversation, "詳しくは", "src");
        key(conversation, "g", "f");
      }
      await waitFor(() => expect(content).toHaveBeenCalledTimes(1));
      const change = { ...diff, seq: 3 };
      if (fromThread) {
        app.record(change, "child");
        app.publish(change, "child");
      } else {
        app.record(change);
        app.setLastSeq(3);
        app.publish(change);
        await waitFor(() =>
          expect(conversation.state.doc.toString().match(/1 -old/g)).toHaveLength(2),
        );
      }
      await act(async () =>
        finish({
          path: "src/order.ts",
          kind: "text",
          size: 25,
          content: "const a = 1;\nconst b = 2;",
        }),
      );
      const file = await buffer(/src\/order.ts.*読み取り専用/, "const b = 2;");
      expect(content).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
      await act(() => app.controller.command(":e"));
      await waitFor(() => expect(file.state.doc.toString()).toContain("const b = 3;"));
      expect(content).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    } finally {
      app.close();
    }
  },
);

test("取得中にスレッドから別のファイルへ移っても中止した取得を表示しない", async () => {
  let finish!: (value: Awaited<ReturnType<FilesApi["content"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<FilesApi["content"]>>>((resolve) => {
    finish = resolve;
  });
  const content = vi.fn<FilesApi["content"]>(async (_id, path) =>
    path === "src/order.ts"
      ? pending
      : { path, kind: "text", size: 17, content: "# スレッドの資料" },
  );
  const app = mount({ content }, "/conversations/c1", { child: "child" });
  try {
    const conversation = await buffer("会話: 予約", "詳しくは");
    select(conversation, "詳しくは", "src");
    key(conversation, "g", "f");
    await waitFor(() => expect(content).toHaveBeenCalledTimes(1));
    app.record(
      { ...reply, payload: { ...reply.payload, text: "README.md を開いてください。" } },
      "child",
    );
    await act(() => app.controller.navigate("/conversations/child"));
    const thread = await buffer("会話: 予約", "README.md を開いてください。");
    expect(content.mock.calls[0][2]?.aborted).toBe(true);
    select(thread, "README.md", "README");
    key(thread, "g", "f");
    const readme = await buffer(/README.md.*読み取り専用/, "スレッドの資料");
    await act(async () =>
      finish({ path: "src/order.ts", kind: "text", size: 12, content: "const b = 2;" }),
    );
    expect(readme.state.doc.toString()).toContain("スレッドの資料");
    expect(screen.queryByRole("region", { name: /src\/order.ts.*読み取り専用/ })).toBeNull();
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    expect(content.mock.calls.map(([, path]) => path)).toEqual(["src/order.ts", "README.md"]);
  } finally {
    app.close();
  }
});

test("履歴でファイルへ戻ると現在の本文を読み、離れていた間の差分は通知しない", async () => {
  const app = mount({}, "/conversations/c1/file?path=src%2Forder.ts&line=1");
  try {
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b");
    select(file, "const b", "b");
    await act(() => app.controller.command(":files order"));
    const results = await buffer("ファイルの名前を検索", "src/order.ts");
    expect(app.socketMessages()).toContainEqual({ op: "unsubscribe", topic: "conversation:c1" });
    app.changeText("const a = 1;\nconst b = 3;\n");
    const previous = { ...diff, seq: 3 };
    app.record(previous);
    app.setLastSeq(3);
    key(results, "-");
    const reopened = await buffer(/src\/order.ts.*読み取り専用/, "const b = 3");
    const lastSubscribe = () =>
      app
        .socketMessages()
        .filter((message) => message.op === "subscribe")
        .at(-1);
    const after = lastSubscribe()?.after;
    if (after < previous.seq) app.publish(previous);
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    expect(lastSubscribe()?.after).toBe(3);
    expect(caret(reopened)).toEqual({ line: 2, column: 6, text: "const b = 3;" });
    expect(app.api.content).toHaveBeenCalledTimes(2);
  } finally {
    app.close();
  }
});

test("ファイル本文の取得中に届いた差分は取得後も通知する", async () => {
  let finish!: (value: Awaited<ReturnType<FilesApi["content"]>>) => void;
  const reading = new Promise<Awaited<ReturnType<FilesApi["content"]>>>((resolve) => {
    finish = resolve;
  });
  const content = vi.fn<FilesApi["content"]>(() => reading);
  const app = mount({ content }, "/conversations/c1/file?path=src%2Forder.ts&line=2");
  try {
    await waitFor(() => expect(content).toHaveBeenCalledTimes(1));
    const change = { ...diff, seq: 3 };
    app.record(change);
    app.setLastSeq(3);
    app.publish(change);
    await act(async () =>
      finish({
        path: "src/order.ts",
        kind: "text",
        size: 25,
        content: "const a = 1;\nconst b = 2;",
      }),
    );
    await buffer(/src\/order.ts.*読み取り専用/, "const b = 2;");
    expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
    expect(content).toHaveBeenCalledTimes(1);
  } finally {
    app.close();
  }
});

test("別画面の読み込みを挟んでも Ctrl+o は保存した位置よりジャンプ先を優先する", async () => {
  const app = mount();
  try {
    const conversation = await buffer("会話: 予約", "詳しくは");
    select(conversation, "詳しくは", "src");
    key(conversation, "g", "f");
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b");
    key(file, "-");
    const returned = await buffer("会話: 予約", "詳しくは");
    select(returned, "最後の行です。");
    await act(() => app.controller.command(":files order"));
    await buffer("ファイルの名前を検索", "src/order.ts");
    await act(() => app.controller.jumpBack());
    const jumped = await buffer("会話: 予約", "詳しくは");
    expect(caret(jumped).text).toContain("詳しくは");
  } finally {
    app.close();
  }
});

test("右ツリーから続けてファイルを開くと、Ctrl+o で本文と右の選択を復元する", async () => {
  const app = mount();
  try {
    const conversation = await buffer("会話: 予約", "詳しくは");
    key(conversation, " ", "e");
    const tree = await buffer("ファイル", "README.md");
    select(tree, "README.md");
    key(tree, "Enter");
    await buffer(/README.md.*読み取り専用/, "A **bold** word.");
    act(() => app.controller.focus("right"));
    select(tree, "▸ src");
    key(tree, "Enter");
    await waitFor(() => expect(tree.state.doc.toString()).toContain("order.ts"));
    select(tree, "order.ts");
    key(tree, "Enter");
    await buffer(/src\/order.ts.*読み取り専用/, "const a");
    select(tree, "README.md");
    await act(() => app.controller.jumpBack());
    await buffer(/README.md.*読み取り専用/, "A **bold** word.");
    expect(caret(tree).text).toBe("    order.ts");
    expect(document.activeElement).toBe(tree.contentDOM);
  } finally {
    app.close();
  }
});

test("消えたファイルをツリーで選ぶと、主に失敗が出てツリーが読み直される", async () => {
  const list = vi
    .fn<FilesApi["list"]>()
    .mockResolvedValueOnce({ files: ["gone.md"], changed: [], truncated: false })
    .mockResolvedValue({ files: ["README.md"], changed: [], truncated: false });
  const app = mount({
    list,
    content: async () => {
      throw new ConversationApiError(404, "not_found", "ファイルがありません: gone.md");
    },
  });
  try {
    key(await buffer("会話: 予約", "詳しくは"), " ", "e");
    const tree = await buffer("ファイル", "gone.md");
    select(tree, "gone.md");
    key(tree, "Enter");
    await buffer(/gone.md.*読み取り専用/, "ファイルがありません: gone.md");
    await waitFor(() => expect(tree.state.doc.toString()).toContain("README.md"));
    expect(tree.state.doc.toString()).not.toContain("gone.md");
  } finally {
    app.close();
  }
});

test("Markdownの記号はカーソル行にだけ出て、Space vでもカーソル行が保たれる", async () => {
  const app = mount({}, "/conversations/c1/file?path=README.md&line=3");
  try {
    const file = await buffer(/README.md.*読み取り専用/, "**bold**");
    const lines = () =>
      Array.from(file.contentDOM.querySelectorAll(".cm-line"), (line) => line.textContent);
    expect(caret(file)).toMatchObject({ line: 3 });
    await waitFor(() =>
      expect(lines()).toEqual(["Intro", "", "A **bold** word.", "[画像: diagram]"]),
    );
    key(file, " ", "v");
    await waitFor(() =>
      expect(lines()).toEqual([
        "# Intro",
        "",
        "A **bold** word.",
        "![diagram](https://fixture.test/p.png)",
      ]),
    );
    expect(caret(file)).toMatchObject({ line: 3 });
    key(file, " ", "v");
    select(file, "# Intro");
    await waitFor(() =>
      expect(lines()).toEqual(["# Intro", "", "A bold word.", "[画像: diagram]"]),
    );
    expect(file.contentDOM.querySelector("img[src]")).toBeNull();
  } finally {
    app.close();
  }
});

test("rgの空白を含む式をそのまま送り、一致の行と桁へ移る", async () => {
  const app = mount();
  try {
    await buffer("会話: 予約", "詳しくは");
    await act(() => app.controller.command(":rg  const  b "));
    const results = await buffer("ファイルの中身を検索", "src/order.ts:2:  const b = 2;");
    expect(app.api.search).toHaveBeenCalledWith(
      "c1",
      "content",
      " const  b ",
      expect.any(AbortSignal),
    );
    key(results, "Enter");
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b");
    expect(caret(file)).toEqual({ line: 2, column: 6, text: "const b = 2;" });
  } finally {
    app.close();
  }
});

test("作業場所内のdiffが配信されても再読込せず、:eまで元の本文と行を保つ", async () => {
  const app = mount({}, "/conversations/c1/file?path=src%2Forder.ts&line=2");
  try {
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b = 2");
    await waitFor(() =>
      expect(app.socketMessages()).toContainEqual({
        op: "subscribe",
        topic: "conversation:c1",
        after: 2,
      }),
    );
    app.changeText("const a = 1;\nconst b = 3;\n");
    app.publish({ ...diff, seq: 3 });
    expect(
      await screen.findByText("AI がこのファイルを変えました。:e で読み直します"),
    ).toBeVisible();
    expect(file.state.doc.toString()).toContain("const b = 2");
    expect(app.api.content).toHaveBeenCalledTimes(1);
    await act(() => app.controller.command(":e"));
    await waitFor(() => expect(file.state.doc.toString()).toContain("const b = 3"));
    expect(caret(file).line).toBe(2);
    expect(screen.queryByText("AI がこのファイルを変えました。:e で読み直します")).toBeNull();
  } finally {
    app.close();
  }
});

test("差分には概要・合計・省略を表示し、削除行を開くと新しい側の位置に移る", async () => {
  const app = mount({}, "/conversations/c1/changes");
  try {
    const view = await buffer("AI が変えた箇所", "-before");
    expect(view.state.doc.toString()).toContain(
      "コマンド (Bash など) で変えたファイルは含みません",
    );
    expect(view.state.doc.toString()).toContain("src/order.ts  追加 1 行、削除 1 行");
    expect(view.state.doc.toString()).toContain("(差分が大きいため、一部を省いています)");
    key(view, " ", "q");
    expect(
      await screen.findByText("差分には、会話かファイルの表示で質問と指示を付けてください"),
    ).toBeVisible();
    key(view, " ", "c");
    expect(app.controller.snapshot().notice?.message).toContain("差分には");
    select(view, "-before");
    key(view, "Enter");
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b");
    expect(caret(file).line).toBe(2);
  } finally {
    app.close();
  }
});

test("差分の編集行のEnterで元の会話の記録へ移る", async () => {
  const app = mount({}, "/conversations/c1/changes");
  try {
    const view = await buffer("AI が変えた箇所", "-before");
    select(view, " 編集");
    key(view, "Enter");
    const conversation = await buffer("会話: 予約", "1 -old");
    expect(caret(conversation).text).toBe("1 -old");
    select(conversation, "最後の行です。");
    expect(caret(conversation).text).toBe("最後の行です。");
    await act(() => app.controller.command(":files order"));
    const results = await buffer("ファイルの名前を検索", "src/order.ts");
    key(results, "-");
    const returned = await buffer("会話: 予約", "1 -old");
    expect(caret(returned).text).toBe("最後の行です。");
  } finally {
    app.close();
  }
});

test("名前検索の結果を選ぶとファイルを開き、戻ると検索結果とカーソルを復元する", async () => {
  const app = mount();
  try {
    await buffer("会話: 予約", "詳しくは");
    await act(() => app.controller.command(":files order ts"));
    const results = await buffer("ファイルの名前を検索", "src/order.ts");
    expect(caret(results).text).toBe("src/order.ts");
    key(results, "Enter");
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const a");
    key(file, "-");
    const returned = await buffer("ファイルの名前を検索", "src/order.ts");
    expect(caret(returned).text).toBe("src/order.ts");
    expect(app.api.search).toHaveBeenCalledTimes(1);
  } finally {
    app.close();
  }
});

test("二つ目の検索は先の通信を止め、先の応答が後着しても画面を入れ替えない", async () => {
  type Result = Awaited<ReturnType<FilesApi["search"]>>;
  let finish!: (value: Result) => void;
  const old = new Promise<Result>((resolve) => {
    finish = resolve;
  });
  let previous: AbortSignal | undefined;
  const search = vi.fn<FilesApi["search"]>(async (_id, _mode, query, signal) => {
    if (query === "old" && !previous) {
      previous = signal;
      return old;
    }
    return { mode: "name", query, matches: [{ path: "latest.md" }], truncated: false };
  });
  const app = mount({ search });
  try {
    await buffer("会話: 予約", "詳しくは");
    await act(() => app.controller.command(":files old"));
    await waitFor(() => expect(previous).toBeDefined());
    await act(() => app.controller.command(":files old"));
    expect(previous?.aborted).toBe(true);
    await act(() => app.controller.command(":files latest"));
    const current = await buffer("ファイルの名前を検索", "latest.md");
    expect(previous?.aborted).toBe(true);
    await act(async () =>
      finish({
        mode: "name",
        query: "old",
        matches: [{ path: "stale.md" }],
        truncated: false,
      }),
    );
    expect(current.state.doc.toString()).toContain("latest.md");
    expect(current.state.doc.toString()).not.toContain("stale.md");
  } finally {
    app.close();
  }
});

test("スレッドの差分も開いているファイルの通知対象にし、離れると購読を解除する", async () => {
  const threads: Awaited<ReturnType<FilesApi["threads"]>> = [
    {
      id: "child",
      title: null,
      stockId: "stock",
      runState: "idle",
      closedAt: null,
      lastActivityAt: null,
      quote: {
        kind: "conversation",
        mode: "line",
        text: "対象",
        start: { seq: 1, line: 0, col: 0 },
        end: { seq: 1, line: 0, col: 2 },
      },
    },
  ];
  const app = mount(
    { threads: async () => threads },
    "/conversations/c1/file?path=src%2Forder.ts&line=2",
    { child: "child" },
  );
  try {
    const file = await buffer(/src\/order.ts.*読み取り専用/, "const b");
    expect(app.socketMessages()).toContainEqual({
      op: "subscribe",
      topic: "conversation:child",
      after: 2,
    });
    app.publish({ ...diff, seq: 1 }, "child");
    expect(screen.queryByText(/AI がこのファイルを変えました/)).toBeNull();
    app.publish({ ...diff, seq: 3 }, "child");
    expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
    expect(file.state.doc.toString()).toContain("const b");
    await act(() => app.controller.navigate("/conversations/c1"));
    await buffer("会話: 予約", "詳しくは");
    expect(app.socketMessages()).toContainEqual({ op: "unsubscribe", topic: "conversation:child" });
  } finally {
    app.close();
  }
});

test("作成の配信が続いてもツリーを一度だけ読み直す", async () => {
  const scheduled = new Set<() => void>();
  const list = vi
    .fn<FilesApi["list"]>()
    .mockResolvedValueOnce({ files: ["README.md"], changed: [], truncated: false })
    .mockResolvedValue({
      files: ["README.md", "new.md", "next.md"],
      changed: ["new.md", "next.md"],
      truncated: false,
    });
  const app = mount({ list }, "/conversations/c1", { scheduled });
  try {
    key(await buffer("会話: 予約", "詳しくは"), " ", "e");
    const tree = await buffer("ファイル", "README.md");
    app.publish({
      ...diff,
      seq: 3,
      payload: { ...diff.payload, path: "new.md", change: "create" },
    });
    app.publish({
      ...diff,
      seq: 4,
      payload: { ...diff.payload, path: "next.md", change: "create" },
    });
    expect(scheduled.size).toBe(1);
    expect(list).toHaveBeenCalledTimes(1);
    act(() => {
      scheduled.forEach((run) => run());
      scheduled.clear();
    });
    await waitFor(() => expect(tree.state.doc.toString()).toContain("next.md"));
    expect(tree.state.doc.toString()).toContain("new.md");
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    app.close();
  }
});

test.each(["rg", "files"])("同じ %s 検索を再実行しても古い履歴の結果は残る", async (command) => {
  let path = "src/order.ts";
  const search = vi.fn<FilesApi["search"]>(async (_id, mode, query) =>
    mode === "name"
      ? { mode, query, matches: [{ path }], truncated: false }
      : {
          mode,
          query,
          matches: [{ path, line: 2, col: 6, text: "const b" }],
          truncated: false,
          timedOut: false,
        },
  );
  const app = mount({ search });
  try {
    await buffer("会話: 予約", "詳しくは");
    await act(() => app.controller.command(`:${command} order`));
    const title = command === "rg" ? "ファイルの中身を検索" : "ファイルの名前を検索";
    await buffer(title, "src/order.ts");
    path = "revised.ts";
    await act(() => app.controller.command(`:${command} order`));
    const after = await buffer(title, "revised.ts");
    expect(after.state.doc.toString()).not.toContain("src/order.ts");
    key(after, "-");
    const history = await buffer(title, "src/order.ts");
    expect(caret(history).text).toContain("src/order.ts");
    expect(search).toHaveBeenCalledTimes(2);
  } finally {
    app.close();
  }
});

test("ファイルの差分メニューは削除済みの差分も数え、印は現在あるファイルだけに付く", async () => {
  const app = mount({
    list: async () => ({ files: ["still.ts"], changed: [], truncated: false }),
    changes: async () => ({ files: [{ path: "deleted.ts", added: 0, removed: 1, changes: [] }] }),
  });
  try {
    key(await buffer("会話: 予約", "詳しくは"), " ", "e");
    const tree = await buffer("ファイル", "AI が変えた箇所 (1 ファイル)");
    expect(tree.state.doc.toString()).not.toContain("deleted.ts");
    expect(tree.dom.querySelector(".cm-mark-gutter")?.textContent).not.toContain("●");
    key(tree, "Enter");
    await buffer("AI が変えた箇所", "deleted.ts");
  } finally {
    app.close();
  }
});

test.each(["gap", "resync"])(
  "ファイルを表示中の %s で欠けた編集を API から復旧する",
  async (kind) => {
    const app = mount({}, "/conversations/c1/file?path=src%2Forder.ts&line=2");
    try {
      const file = await buffer(/src\/order.ts.*読み取り専用/, "const b");
      await waitFor(() =>
        expect(app.socketMessages()).toContainEqual({
          op: "subscribe",
          topic: "conversation:c1",
          after: 2,
        }),
      );
      app.record({ ...diff, seq: 3 });
      if (kind === "resync")
        app.receive({ type: "resync", topic: "conversation:c1", seq: 3, payload: { last_seq: 3 } });
      else {
        const later = { ...reply, seq: 4 };
        app.record(later);
        app.publish(later);
      }
      expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
      expect(file.state.doc.toString()).toContain("const b");
      expect(app.api.content).toHaveBeenCalledTimes(1);
    } finally {
      app.close();
    }
  },
);

const arrivingThread: Awaited<ReturnType<FilesApi["threads"]>>[number] = {
  id: "child",
  title: "修正確認",
  stockId: "stock",
  runState: "idle",
  closedAt: null,
  lastActivityAt: null,
  quote: {
    kind: "conversation",
    mode: "line",
    text: "対象",
    start: { seq: 1, line: 0, col: 0 },
    end: { seq: 1, line: 0, col: 2 },
  },
};

test.each(["通知", "再接続"])(
  "表示中に %s で発見したスレッドの変更は、購読より前でも通知する",
  async (discovery) => {
    let threads: (typeof arrivingThread)[] = [];
    const app = mount(
      { threads: async () => threads },
      "/conversations/c1/file?path=src%2Forder.ts&line=2",
      { child: "child" },
    );
    try {
      const file = await buffer(/src\/order.ts.*読み取り専用/, "const b");
      if (discovery === "再接続") app.disconnect();
      threads = [arrivingThread];
      app.record(reply, "child");
      app.record(diff, "child");
      if (discovery === "再接続") app.reconnect();
      else
        app.receive({
          topic: "conversation:c1",
          seq: 2,
          type: "changed",
          payload: { parts: ["threads"] },
        });
      const subscriptions = () =>
        app
          .socketMessages()
          .filter((entry) => entry.op === "subscribe" && entry.topic === "conversation:child");
      await waitFor(() => expect(subscriptions()).toHaveLength(1));
      for (const event of [reply, diff])
        if (event.seq > subscriptions()[0].after) app.publish(event, "child");
      expect(await screen.findByText(/AI がこのファイルを変えました/)).toBeVisible();
      expect(file.state.doc.toString()).toContain("const b");
      expect(
        app
          .socketMessages()
          .filter((entry) => entry.op === "shown")
          .at(-1)?.topics,
      ).toEqual([]);
    } finally {
      app.close();
    }
  },
);

test("自動リンクはカーソル行以外で山括弧を隠し、インラインと参照リンクは文字を残す", async () => {
  const content = [
    "# Links",
    "<https://fixture.test/docs>",
    "<help@fixture.test>",
    "[読む](https://fixture.test/reference)",
    "[参照リンク][docs]",
    "",
    "[docs]: https://fixture.test",
  ].join("\n");
  const app = mount(
    {
      async content(_id, path) {
        return { path, kind: "text", size: content.length, content };
      },
    },
    "/conversations/c1/file?path=README.md&line=1",
  );
  try {
    const file = await buffer(/README.md.*読み取り専用/, "<https://fixture.test/docs>");
    const rendered = () => Array.from(file.contentDOM.querySelectorAll(".cm-line"));
    expect(rendered()[3].textContent).toBe("読む");
    expect(rendered()[4].textContent).toBe("参照リンク");
    select(file, "<https://fixture.test/docs>");
    expect(caret(file).line).toBe(2);
    expect(rendered()[1].textContent).toBe("<https://fixture.test/docs>");
    select(file, "# Links");
    expect(caret(file).line).toBe(1);
    expect(
      rendered()
        .slice(1, 3)
        .map((line) => line.textContent),
    ).toEqual(["https://fixture.test/docs", "help@fixture.test"]);
  } finally {
    app.close();
  }
});

test("Markdownのソース表示は自動リンクの山括弧とカーソル行を保つ", async () => {
  const content = "# Links\n<https://fixture.test/docs>\n<help@fixture.test>";
  const app = mount(
    {
      async content(_id, path) {
        return { path, kind: "text", size: content.length, content };
      },
    },
    "/conversations/c1/file?path=README.md&line=1",
  );
  try {
    const file = await buffer(/README.md.*読み取り専用/, content);
    const rendered = () =>
      Array.from(file.contentDOM.querySelectorAll(".cm-line"), (line) => line.textContent);
    key(file, " ", "v");
    await waitFor(() => expect(rendered()).toEqual(content.split("\n")));
    expect(caret(file).line).toBe(1);
  } finally {
    app.close();
  }
});

test("裸のGFMリンクにもリンク色が付き通常のリンクと同じように見える", async () => {
  const content = "# Links\nhttps://fixture.test/docs\n[読む](https://fixture.test/reference)";
  const app = mount(
    {
      async content(_id, path) {
        return { path, kind: "text", size: content.length, content };
      },
    },
    "/conversations/c1/file?path=README.md&line=1",
  );
  try {
    const file = await buffer(/README.md.*読み取り専用/, "https://fixture.test/docs");
    const highlighted = () =>
      Array.from(file.contentDOM.querySelectorAll(".cm-file-link"), (el) => el.textContent);
    expect(highlighted()).toEqual(["https://fixture.test/docs", "読む"]);
  } finally {
    app.close();
  }
});

test.each([
  { name: "CRLF", separator: "\r\n" },
  { name: "単独CR", separator: "\r" },
])("改行が$nameのファイルを読み直しても選んだ行を保つ", async ({ separator }) => {
  let raw = ["first", "original", "third"].join(separator);
  const app = mount(
    {
      async content(_id, path) {
        return { path, size: raw.length, kind: "text", content: raw.replaceAll("\r\n", "\n") };
      },
    },
    "/conversations/c1/file?path=src%2Forder.ts&line=1",
  );
  try {
    const file = await buffer(/src\/order.ts.*読み取り専用/, "original");
    expect(file.state.doc.toString()).toContain("original");
    await act(() => app.controller.command(":2"));
    const before = caret(file);
    raw = ["first", "changed", "third"].join(separator);
    await act(() => app.controller.command(":e"));
    await waitFor(() => expect(file.state.doc.toString()).toContain("changed"));
    expect({ before, after: caret(file) }).toEqual({
      before: { line: 2, column: 0, text: "original" },
      after: { line: 2, column: 0, text: "changed" },
    });
  } finally {
    app.close();
  }
});
