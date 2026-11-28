import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { ConversationApiError, createConversationApi } from "../../lib/conversation/api";
import { createStockApi } from "../../lib/stock/api";
import { createWorktreeLocation, worktreeSelection } from "../../lib/worktree-location";
import { createWorktreeApi } from "../../lib/worktree-api";
import { createWorktreeWorkspace } from "../../lib/worktree-workspace";
import type { TerminalOutputFrame } from "../../../shared/api/terminal";
import { Layout } from "../../buffer/Layout";
import { BufferController } from "../../buffer/controller";
import {
  createTerminalComposer,
  registerTerminalOpen,
  TerminalPage,
  type TerminalRecord,
} from "./terminal-page";

const record: TerminalRecord = {
  opened: {
    id: "term",
    cwd: "/test",
    label: "worktree: demo",
    conversationId: null,
    reused: false,
  },
  input: { projectId: "p", worktreeId: "w", conversationId: null, cols: 120, rows: 40 },
  projectName: "demo",
};
function mount(
  exists = vi.fn(async () => false),
  destination: string | null = null,
  delayed = false,
  findDestination: (id: string) => Promise<{ title: string } | null> = async () => ({
    title: "作業の会話",
  }),
) {
  const controller = new BufferController();
  const send = vi.fn();
  const recordForPage = {
    ...record,
    opened: { ...record.opened, conversationId: destination },
    input: { ...record.input, conversationId: destination },
  };
  const remember = vi.fn();
  const requests: unknown[] = [];
  const stock = createStockApi(async (_path, init) => {
    if (init?.method !== "POST" || typeof init.body !== "string")
      return Response.json({ items: [] });
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({
      item: {
        ...body,
        id: "stocked",
        conversationId: destination,
        state: "stocked",
        stale: false,
        sentAt: null,
        sentSeq: null,
        thread: null,
        githubCommentUrl: null,
      },
    });
  });
  const restart = vi.fn(async () => record);
  const key = vi.fn();
  let contents = delayed ? [] : ["command output"];
  const writes: (() => void)[] = [];
  let messages: (frame: TerminalOutputFrame) => void;
  let closed: () => void;
  const createSurface = vi.fn((host: HTMLDivElement) => ({
    focus: () => host.focus(),
    fit: () => ({ cols: 120, rows: 40 }),
    resize: vi.fn(),
    write: (text: string, done: () => void) => {
      if (delayed)
        writes.push(() => {
          contents = [text];
          done();
        });
      else done();
    },
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    lines: () => contents,
    onKey: key,
    observe: () => () => {},
    dispose: vi.fn(),
  }));
  const connect = vi.fn(
    (_id: string, handlers: { frame: (value: TerminalOutputFrame) => void; close: () => void }) => {
      messages = handlers.frame;
      closed = handlers.close;
      return { send, close: vi.fn() };
    },
  );
  render(
    <Layout
      controller={controller}
      main={
        <TerminalPage
          initial={recordForPage}
          controller={controller}
          terminal={{ connect, createSurface, exists, restart }}
          remember={remember}
          initialMode="input"
          rememberMode={vi.fn()}
          compose={createTerminalComposer(controller, findDestination, stock)}
        />
      }
    />,
  );
  return {
    controller,
    requests,
    flush: () => act(() => writes.splice(0).forEach((done) => done())),
    send,
    key,
    connect,
    restart,
    exists,
    remember,
    frame: (value: TerminalOutputFrame) => act(() => messages(value)),
    disconnect: () => act(() => closed()),
  };
}

it("xterm の入力中に Ctrl+[ は Esc を送り、Ctrl+] は出力を Normal で表示する", async () => {
  const ui = mount();
  ui.frame({ type: "snapshot", cols: 120, rows: 40, data: "output" });
  const onKey = ui.key.mock.calls[0][0] as (event: KeyboardEvent) => boolean;
  act(() => {
    onKey(new KeyboardEvent("keydown", { key: "[", ctrlKey: true }));
    onKey(new KeyboardEvent("keydown", { key: "]", ctrlKey: true }));
  });
  await screen.findByText("command output");
  expect(ui.send.mock.calls.filter(([frame]) => frame.type === "input")).toEqual([
    [{ type: "input", data: "\u001b" }],
  ]);
  expect(ui.controller.snapshot().mode).toBe("NORMAL");
});

it("終了のフレームを表示し、i で同じ端末の作業場所を開く", async () => {
  const ui = mount();
  ui.frame({ type: "snapshot", cols: 120, rows: 40, data: "" });
  ui.frame({ type: "exit", code: 0, signal: null });
  await screen.findByText("[終了しました (コード 0)]");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "バッファ" }), { key: "i" });
  await waitFor(() => expect(ui.restart).toHaveBeenCalledWith(record));
});

it("終了済みの端末へ接続すると最後の出力と終了結果を読む", async () => {
  const ui = mount(undefined, null, true);
  ui.frame({ type: "snapshot", cols: 120, rows: 40, data: "last output" });
  ui.frame({ type: "exit", code: 0, signal: null });
  ui.flush();
  await screen.findByText("last output");
  expect(screen.getByText("[終了しました (コード 0)]")).toBeVisible();
});

it("つながっていた端末の ID が残っていればシェルを開かず再接続する", async () => {
  const ui = mount(vi.fn(async () => true));
  ui.frame({ type: "snapshot", cols: 120, rows: 40, data: "output" });
  ui.disconnect();
  await waitFor(() => expect(ui.connect.mock.calls.map(([id]) => id)).toEqual(["term", "term"]));
  expect(ui.restart).not.toHaveBeenCalled();
});

it("再接続前に ID が消えていればサーバー再起動として表示する", async () => {
  const ui = mount();
  ui.disconnect();
  await screen.findByText(
    "ターミナルは終了しています (画面のサーバーが再起動しました)。i で新しく開きます",
  );
  expect(ui.exists).toHaveBeenCalledWith("term", expect.any(AbortSignal));
  expect(ui.restart).not.toHaveBeenCalled();
});

it("接続と存在確認の両方が失敗したら再読み込みを提示する", async () => {
  const ui = mount(
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
  ui.disconnect();
  await screen.findByText("ターミナルにつながりません");
  expect(screen.getByText(/再読み込み/)).toBeVisible();
});

function normal(ui: ReturnType<typeof mount>) {
  ui.frame({ type: "snapshot", cols: 120, rows: 40, data: "output" });
  const onKey = ui.key.mock.calls[0][0] as (event: KeyboardEvent) => boolean;
  act(() => {
    onKey(new KeyboardEvent("keydown", { key: "]", ctrlKey: true }));
  });
}

it.each([
  { key: "q", kind: "question" },
  { key: "c", kind: "instruction" },
] as const)(
  "Normal の Space $key は選んだ出力を $kind の terminal 引用にする",
  async ({ key, kind }) => {
    const ui = mount(undefined, "c");
    normal(ui);
    await screen.findByText("command output");
    const buffer = screen.getByRole("textbox", { name: "バッファ" });
    await act(async () => {
      fireEvent.keyDown(buffer, { key: " " });
      fireEvent.keyDown(buffer, { key });
    });
    await screen.findByRole("textbox", { name: kind === "question" ? "質問" : "指示" });
    act(() => ui.controller.replacePromptText("行について"));
    await act(async () => ui.controller.submitPrompt("行について"));
    expect(ui.requests).toEqual([
      {
        kind,
        text: "行について",
        quote: { kind: "terminal", text: "command output", mode: "line" },
      },
    ]);
  },
);

it("送り先のない端末からのストックは理由を表示して送らない", async () => {
  const ui = mount();
  normal(ui);
  await screen.findByText("command output");
  const buffer = screen.getByRole("textbox", { name: "バッファ" });
  await act(async () => {
    fireEvent.keyDown(buffer, { key: " " });
    fireEvent.keyDown(buffer, { key: "q" });
  });
  expect(ui.controller.snapshot().notice?.message).toBe(
    "送り先の会話がありません。会話か issue を開いてから押してください",
  );
  expect(ui.requests).toEqual([]);
});

it("出力を開いている間に送り先が削除されると、端末を維持して送り先の記録を消す", async () => {
  const findDestination = vi.fn(async () => null);
  const ui = mount(undefined, "c", false, findDestination);
  normal(ui);
  await screen.findByText("command output");
  const buffer = screen.getByRole("textbox", { name: "バッファ" });

  await act(async () => {
    fireEvent.keyDown(buffer, { key: " " });
    fireEvent.keyDown(buffer, { key: "c" });
  });
  expect(ui.controller.snapshot().notice?.message).toBe(
    "送り先の会話がありません。会話か issue を開いてから押してください",
  );
  expect(ui.remember).toHaveBeenCalledWith(record);
  expect(ui.connect).toHaveBeenCalledTimes(1);
  expect(ui.requests).toEqual([]);
  await act(async () => {
    fireEvent.keyDown(buffer, { key: "Escape" });
    fireEvent.keyDown(buffer, { key: " " });
    fireEvent.keyDown(buffer, { key: "q" });
  });
  expect(findDestination).toHaveBeenCalledTimes(1);
});

it("出力の質問時に送り先の取得が一時的に失敗しても、再試行で同じ会話を使う", async () => {
  const findDestination = vi.fn(async (_id: string) => ({ title: "作業の会話" }));
  findDestination.mockRejectedValueOnce(new ConversationApiError(503, "offline", "再試行できます"));
  const ui = mount(undefined, "c", false, findDestination);
  normal(ui);
  await screen.findByText("command output");
  const buffer = screen.getByRole("textbox", { name: "バッファ" });

  await act(async () => {
    fireEvent.keyDown(buffer, { key: " " });
    fireEvent.keyDown(buffer, { key: "q" });
  });
  expect(ui.controller.snapshot().notice?.message).toBe("再試行できます");
  await act(async () => {
    fireEvent.keyDown(buffer, { key: "Escape" });
    fireEvent.keyDown(buffer, { key: " " });
    fireEvent.keyDown(buffer, { key: "q" });
  });
  await screen.findByRole("textbox", { name: "質問" });
  expect(findDestination.mock.calls).toEqual([["c"], ["c"]]);
  expect(ui.remember).not.toHaveBeenCalled();
});

it.each([
  {
    route: "/conversations/c",
    stage: [],
    selected: null,
    expectedWorktree: null,
    expectedConversation: "c",
  },
  {
    route: "/issues/i",
    stage: ["design", "impl"],
    selected: null,
    expectedWorktree: null,
    expectedConversation: "impl",
  },
  {
    route: "/issues/i",
    stage: ["design"],
    selected: null,
    expectedWorktree: null,
    expectedConversation: "design",
  },
  {
    route: "/issues/i",
    stage: ["triage"],
    selected: null,
    expectedWorktree: null,
    expectedConversation: null,
  },
  {
    route: "/projects/p",
    stage: [],
    selected: "chosen",
    expectedWorktree: "chosen",
    expectedConversation: null,
  },
  {
    route: "/projects/p",
    stage: [],
    selected: null,
    expectedWorktree: null,
    expectedConversation: null,
  },
] as const)("Space g の $route で開く場所を決める ($stage / $selected)", async (fixture) => {
  const storage = worktreeSelection(window.sessionStorage);
  storage.write("p", fixture.selected);
  const controller = new BufferController({ url: fixture.route });
  const requests: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async (path, init) => {
    if (typeof path !== "string") throw new Error("URL は文字列で指定します");
    if (path === "/api/terminals") {
      if (typeof init?.body !== "string") throw new Error("作業場所を指定します");
      requests.push(JSON.parse(init.body));
      return Response.json(record.opened, { status: 201 });
    }
    if (path === "/api/projects")
      return Response.json({ projects: [{ id: "p", name: "project" }] });
    if (path === "/api/issues/i")
      return Response.json({
        issue: {
          projectId: "p",
          state: "design",
          conversations: fixture.stage.map((kind) => ({ id: kind, kind })),
        },
      });
    const id = path.split("/").at(-1);
    return Response.json({
      conversation: {
        id,
        projectId: "p",
        projectName: "project",
        worktree: { id: id === "c" ? "w" : id + "-w" },
      },
    });
  });
  const api = createWorktreeApi(fetcher);
  const conversations = createConversationApi(fetcher);
  const locate = createWorktreeLocation({
    conversation: conversations.get,
    projects: conversations.projects,
    issue: api.issue,
    selection: storage,
  });
  const show = vi.fn();
  const unregister = registerTerminalOpen(controller, locate, api.openTerminal, show);
  try {
    await controller.run("terminal.open");
    expect(requests).toEqual([
      {
        projectId: "p",
        worktreeId: fixture.expectedWorktree,
        conversationId: fixture.expectedConversation,
        cols: 120,
        rows: 40,
      },
    ]);
    expect(show).toHaveBeenCalledExactlyOnceWith({
      projectName: "project",
      opened: record.opened,
      input: requests[0],
    });
  } finally {
    unregister();
  }
});

it.each([
  { status: 404, expected: null },
  { status: 503, expected: "previous" },
  { status: 200, expected: "previous" },
])(
  "プロジェクトで開いた端末に会話の応答 $status に応じた送り先を保存する",
  async ({ status, expected }) => {
    const controller = new BufferController({ url: "/projects/p" });
    const fetcher = vi.fn<typeof fetch>(async (path) => {
      if (typeof path !== "string") throw new Error("URL は文字列で指定します");
      if (path === "/api/projects") return Response.json({ projects: [{ id: "p", name: "demo" }] });
      if (path === "/api/terminals")
        return Response.json({ ...record.opened, conversationId: "previous", reused: true });
      if (path === "/api/conversations/previous") {
        return status === 200
          ? Response.json({ conversation: { id: "previous", title: "前回の会話" } })
          : Response.json(
              { error: { code: "unavailable", message: "取得できません" } },
              { status },
            );
      }
      throw new Error(`予定外の取得先: ${path}`);
    });
    const workspace = createWorktreeWorkspace({
      browser: window,
      controller,
      api: createWorktreeApi(fetcher),
      conversations: createConversationApi(fetcher),
      stock: createStockApi(fetcher),
    });
    const storageKey = "sukuna:terminal:term";
    const unregister = workspace.start();
    try {
      await controller.run("terminal.open");
      expect(controller.options.url).toBe("/terminals/term");
      expect(JSON.parse(window.sessionStorage.getItem(storageKey)!)).toMatchObject({
        opened: { id: "term", conversationId: expected },
      });
      expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
        "/api/projects",
        "/api/terminals",
        "/api/conversations/previous",
      ]);
    } finally {
      unregister();
      window.sessionStorage.removeItem(storageKey);
    }
  },
);
