import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import type { StockItem } from "../../../shared/stock";
import type { ServerMessage } from "../../../shared/ws";
import { Buffer } from "../../buffer/Buffer";
import { Frame } from "../../buffer/Frame";
import { Layout } from "../../buffer/Layout";
import { BufferController } from "../../buffer/controller";
import type { LineInfo } from "../../buffer/line";
import { ConversationApiError, createConversationApi } from "../../lib/conversation/api";
import type { Snapshot } from "../../lib/conversation/types";
import { markdownPreview } from "../../lib/files/markdown-decorations";
import type { StockApi } from "../../lib/stock/api";
import { conversationSource, fileSource } from "../../lib/stock/quote";
import { createStockWorkspace } from "../../lib/stock/workspace";

const conversationLines: LineInfo[] = [
  { kind: "text", text: "abcd", seq: 1, seqLine: 0 },
  { kind: "text", text: "xyzt", seq: 1, seqLine: 1 },
  { kind: "separator", text: "ここから未読" },
];
const fileLines: LineInfo[] = [{ kind: "code", text: "# **見出し**" }];

async function fixture(
  lines = conversationLines,
  view = "conversation",
  initial: StockItem[] = [],
  conversations = createConversationApi(async () => new Response(null, { status: 404 })),
) {
  let items = initial;
  const callbacks = new Set<(message?: ServerMessage) => void>();
  const file = view !== "conversation";
  const openFile = vi.fn<() => void>();
  const api = {
    list: vi.fn(async () => items.filter((item) => item.state !== "cancelled")),
    threads: vi.fn(async () => []),
    add: vi.fn<StockApi["add"]>(async (conversationId, body) => {
      const item: StockItem = {
        ...body,
        id: "a",
        conversationId,
        state: "stocked",
        stale: false,
        sentAt: null,
        sentSeq: null,
        thread: null,
        githubCommentUrl: null,
      };
      items = [item];
      return item;
    }),
    edit: vi.fn<StockApi["edit"]>(async (id, text) => {
      const edited = { ...items.find((item) => item.id === id)!, text };
      items = [edited];
      return edited;
    }),
    cancel: vi.fn<StockApi["cancel"]>(async (id) => {
      const cancelled = { ...items.find((item) => item.id === id)!, state: "cancelled" as const };
      items = [cancelled];
      return cancelled;
    }),
    restore: vi.fn<StockApi["restore"]>(async (id) => {
      const restored = { ...items.find((item) => item.id === id)!, state: "stocked" as const };
      items = [restored];
      return restored;
    }),
    send: vi.fn(async () => ({ instructions: { count: 0, delivery: null }, questions: [] })),
    propose: vi.fn(async () => null),
    close: vi.fn(async () => ({ id: "thread", closedAt: 100 })),
    finish: vi.fn(async () => ({ item: items[0], thread: { id: "thread", closedAt: 100 } })),
  } satisfies StockApi;
  const controller = new BufferController({
    url: file ? "/conversations/c/file?path=readme.md&line=1" : "/conversations/c",
  });
  const workspace = createStockWorkspace({
    api,
    controller,
    conversations,
    env: { clientId: "test", id: () => "entry", now: () => 0, schedule: () => () => {} },
    subscribe: (_topic, callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    showConversation: () => () => {},
    openFile,
    queuedId: () => undefined,
  });
  const stop = workspace.start();
  workspace.enter({ id: "c", title: "予約の会話", issueId: null, cwd: "/tmp/shop" });
  const store = workspace.session("c");
  const frame = render(
    <Layout
      controller={controller}
      renderRight={(view) => workspace.right(view)}
      main={
        <Frame side="main" title="本文">
          <Buffer
            side="main"
            viewName={view}
            lines={lines}
            marks={store.bufferMarks(
              file ? (value) => fileSource("readme.md", value) : conversationSource,
            )}
            display={view === "markdown-file" ? markdownPreview : undefined}
            onReady={() => {}}
          />
        </Frame>
      }
    />,
  );
  await act(async () => {});
  const main = screen.getByRole("region", { name: "本文" });
  const editor = EditorView.findFromDOM(main.querySelector(".cm-editor")!)!;
  const press = async (
    ...keys: (string | { key: string; ctrlKey?: boolean; shiftKey?: boolean })[]
  ) => {
    await act(async () => {
      for (const key of keys) {
        const target = document.activeElement!;
        fireEvent.keyDown(target, typeof key === "string" ? { key } : key);
      }
    });
  };
  const submit = async (text: string) => {
    await act(async () => {
      controller.setPromptDraft(text);
      await controller.submitPrompt(text);
    });
  };
  const focus = (line: number, col: number) =>
    act(() => {
      editor.focus();
      controller.place("main", line, col);
    });
  const marks = () =>
    [...main.querySelectorAll(".cm-gutters .cm-gutterElement span")]
      .map((node) => node.textContent)
      .filter((text) => text === "!" || text === "?" || text === "›");
  return {
    api,
    controller,
    main,
    marks,
    press,
    submit,
    focus,
    update: async (replacement: StockItem[]) => {
      items = replacement;
      await act(async () => {
        callbacks.forEach((callback) =>
          callback({
            type: "changed",
            topic: "conversation:c",
            seq: 2,
            payload: { parts: ["stock"] },
          }),
        );
      });
    },
    close: () =>
      act(() => {
        frame.unmount();
        stop();
      }),
  };
}

it("文字の選択を会話の1行から引用して質問を入れる", async () => {
  const f = await fixture();
  try {
    f.focus(0, 1);
    await f.press("v", "l", " ", "q");
    expect(f.marks()).toEqual(["›"]);
    await f.submit("質問を保存");
    expect(f.api.add).toHaveBeenCalledWith("c", {
      kind: "question",
      text: "質問を保存",
      quote: {
        kind: "conversation",
        mode: "char",
        text: "bc",
        start: { seq: 1, line: 0, col: 1 },
        end: { seq: 1, line: 0, col: 3 },
      },
    });
    expect(f.marks()).toEqual(["?"]);
  } finally {
    f.close();
  }
});

it("矩形で二行を選ぶと両行の同じ桁を引用し、取り消しとuで印が変わる", async () => {
  const f = await fixture();
  try {
    f.focus(0, 1);
    await f.press({ key: "v", ctrlKey: true }, "2", "G", "0", "l", "l");
    await f.press(" ", "c");
    await f.submit("指示を保存");
    expect(f.api.add).toHaveBeenCalledWith("c", {
      kind: "instruction",
      text: "指示を保存",
      quote: {
        kind: "conversation",
        mode: "block",
        text: "bc\nyz",
        start: { seq: 1, line: 0, col: 1 },
        end: { seq: 1, line: 1, col: 3 },
      },
    });
    expect(f.marks()).toEqual(["!", "!"]);
    await f.press("d", "d");
    expect(f.marks()).toEqual([]);
    expect(f.api.cancel).toHaveBeenCalledWith("a");
    await f.press("u");
    expect(f.marks()).toEqual(["!", "!"]);
    expect(f.api.restore).toHaveBeenCalledWith("a");
  } finally {
    f.close();
  }
});

it("選ばない場合は行を引用し、印のEnterでストックへ移って編集できる", async () => {
  const f = await fixture();
  try {
    f.focus(1, 1);
    await f.press(" ", "c");
    await f.submit("直して");
    expect(f.api.add).toHaveBeenCalledWith("c", {
      kind: "instruction",
      text: "直して",
      quote: {
        kind: "conversation",
        mode: "line",
        text: "xyzt",
        start: { seq: 1, line: 1, col: 0 },
        end: { seq: 1, line: 1, col: 4 },
      },
    });
    await f.press("Enter");
    const right = await screen.findByRole("region", { name: "ストック: 予約の会話" });
    await waitFor(() =>
      expect(within(right).getByText("! 会話 直して", { exact: true })).toBeVisible(),
    );
    expect(within(right).getByText("> xyzt", { exact: true })).toBeVisible();
    await f.press("c", "c");
    expect(f.controller.snapshot().prompt?.initialText).toBe("直して");
    await f.submit("追記して");
    expect(f.api.edit).toHaveBeenCalledWith("a", "追記して");
  } finally {
    f.close();
  }
});

it("装飾を表示したMarkdownの選択がソースの位置になり、配信後は古い印だけ消える", async () => {
  const f = await fixture(fileLines, "markdown-file");
  try {
    f.focus(0, 4);
    await f.press("v", "l", "l", " ", "q");
    await f.submit("見出しの質問");
    const quote = {
      kind: "file",
      mode: "char",
      path: "readme.md",
      text: "見出し",
      start: { line: 1, col: 4 },
      end: { line: 1, col: 7 },
    } as const;
    expect(f.api.add).toHaveBeenCalledWith("c", { kind: "question", text: "見出しの質問", quote });
    expect(f.marks()).toEqual(["?"]);
    await f.update([
      {
        id: "a",
        conversationId: "c",
        kind: "question",
        text: "見出しの質問",
        quote,
        state: "stocked",
        stale: true,
        sentAt: null,
        sentSeq: null,
        thread: null,
        githubCommentUrl: null,
      },
    ]);
    expect(f.marks()).toEqual([]);
    await f.press(" ", "l");
    const right = await screen.findByRole("region", { name: "ストック: 予約の会話" });
    expect(
      within(right).getByText("箇所が古くなっています (保存した引用の文を出しています)", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    f.close();
  }
});

it("普通のファイルで指示を書けて、会話の区切りでは理由を知らせる", async () => {
  const file = await fixture([{ kind: "code", text: "return value" }], "file");
  try {
    file.focus(0, 3);
    await file.press(" ", "c");
    await file.submit("戻り値を変える");
    expect(file.api.add).toHaveBeenCalledWith("c", {
      kind: "instruction",
      text: "戻り値を変える",
      quote: {
        kind: "file",
        mode: "line",
        path: "readme.md",
        text: "return value",
        start: { line: 1, col: 0 },
        end: { line: 1, col: 12 },
      },
    });
    expect(file.marks()).toEqual(["!"]);
  } finally {
    file.close();
  }

  const conversation = await fixture([
    { kind: "separator", text: "ここから未読", seq: 1, seqLine: 0 },
  ]);
  try {
    conversation.focus(0, 0);
    await conversation.press(" ", "q");
    expect(conversation.controller.snapshot().notice?.message).toBe(
      "この行には質問と指示を付けられません",
    );
  } finally {
    conversation.close();
  }
});

it("Vで選んだ二行は最後の行の行末まで指示に入れる", async () => {
  const f = await fixture();
  try {
    f.focus(0, 2);
    await f.press({ key: "V", shiftKey: true }, "2", "G", " ", "c");
    await f.submit("二行を保存");
    expect(f.api.add).toHaveBeenCalledWith("c", {
      kind: "instruction",
      text: "二行を保存",
      quote: {
        kind: "conversation",
        mode: "line",
        text: "abcd\nxyzt",
        start: { seq: 1, line: 0, col: 0 },
        end: { seq: 1, line: 1, col: 4 },
      },
    });
  } finally {
    f.close();
  }
});

const stockSeed = (id: string, text: string, start: number, end = start): StockItem => ({
  id,
  conversationId: "c",
  kind: "instruction",
  text,
  state: "stocked",
  stale: false,
  sentAt: null,
  sentSeq: null,
  thread: null,
  githubCommentUrl: null,
  quote: {
    kind: "conversation",
    mode: "line",
    text,
    start: { seq: 1, line: start, col: 0 },
    end: { seq: 1, line: end, col: 4 },
  },
});

it("終えたスレッドの ✓ の行で Enter を押すと、右にそのスレッドが開く", async () => {
  const title = "期限についての質問";
  const snapshot = {
    conversation: {
      id: "thread",
      projectId: "p",
      projectName: "予約管理",
      kind: "thread",
      issueId: null,
      parentConversationId: "c",
      title,
      cwd: "/tmp/shop",
      worktree: null,
      runState: "idle",
      stopReason: null,
      resetsAt: null,
      lastSeq: 0,
      lastReadSeq: 0,
      lastPosition: null,
      closedAt: 100,
    },
    draft: null,
    queue: [],
    pendingAnswers: null,
    pendingPermission: null,
    commands: [],
  } satisfies Snapshot;
  const conversations = createConversationApi(async (path) => {
    if (path === "/api/conversations/thread") return Response.json(snapshot);
    if (typeof path === "string" && path.startsWith("/api/conversations/thread/events?"))
      return Response.json({ events: [], lastSeq: 0, hasMore: false });
    return new Response(null, { status: 404 });
  });
  const f = await fixture(
    conversationLines,
    "conversation",
    [
      {
        ...stockSeed("question", "abcd", 0),
        kind: "question",
        state: "sent",
        sentAt: 1,
        thread: { id: "thread", title, runState: "idle", closed: true },
      },
    ],
    conversations,
  );
  try {
    await waitFor(() => expect(within(f.main).getByText("✓", { exact: true })).toBeVisible());
    f.focus(0, 0);
    await f.press("Enter");
    const thread = await screen.findByRole("region", { name: `スレッド: ${title}` });
    expect(await within(thread).findByText(/再開する/)).toBeVisible();
  } finally {
    f.close();
  }
});

it("非引用の行で分かれても ]c と [c は同じ件を再び数えない", async () => {
  const f = await fixture(
    [
      { kind: "text", text: "第一行", seq: 1, seqLine: 0 },
      { kind: "separator", text: "区切り" },
      { kind: "text", text: "同じ件の第二行", seq: 1, seqLine: 1 },
      { kind: "text", text: "別の件", seq: 1, seqLine: 2 },
    ],
    "conversation",
    [stockSeed("a", "第一行\n同じ件の第二行", 0, 1), stockSeed("b", "別の件", 2)],
  );
  try {
    f.focus(0, 0);
    await f.press("]", "c");
    expect(f.controller.currentLine("main")?.text).toBe("別の件");
    await f.press("[", "c");
    expect(f.controller.currentLine("main")?.text).toBe("第一行");
  } finally {
    f.close();
  }
});

it("引用品の入力欄は先頭5行と残件数を示し、未保存文を捨てると案内する", async () => {
  const f = await fixture(conversationLines, "conversation", [
    stockSeed("a", "一\n二\n三\n四\n五\n六", 0),
  ]);
  try {
    f.focus(0, 0);
    await f.press(" ", "c");
    expect(f.controller.snapshot().prompt?.quote).toEqual(["一", "二", "三", "四", "五", "六"]);
    expect(screen.getByText("…ほか 1 行", { exact: true })).toBeVisible();
    await f.press("Escape");
    expect(
      screen.getByText("Enter ストックする Esc 閉じる (書きかけは捨てる)", { exact: true }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("status")).getByText("主のウィンドウへ移る (入力欄は開いたまま)", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    f.close();
  }
});

it("取り消し済みの新しい件をuで戻したあとも、遅い古い応答を復元対象にしない", async () => {
  const first = stockSeed("a", "先の指示", 0);
  const second = stockSeed("b", "後の指示", 1);
  const f = await fixture(conversationLines, "conversation", [first, second]);
  try {
    let resolveFirst!: (item: StockItem) => void;
    const firstResponse = new Promise<StockItem>((resolve) => {
      resolveFirst = resolve;
    });
    f.api.cancel.mockImplementationOnce(() => firstResponse);
    f.focus(0, 0);
    await f.press("d", "d");
    f.focus(1, 0);
    await f.press("d", "d");
    await f.press("u");
    expect(f.api.restore.mock.calls).toEqual([["b"]]);
    await act(async () => resolveFirst({ ...first, state: "cancelled" }));
    await f.press("u");
    expect(f.api.restore.mock.calls).toEqual([["b"]]);
  } finally {
    f.close();
  }
});

it("新しい取消しが配信された後も、応答がそろうまでuで先の別件を戻さない", async () => {
  const first = stockSeed("a", "先の指示", 0);
  const second = stockSeed("b", "後の指示", 1);
  const f = await fixture(conversationLines, "conversation", [first, second]);
  try {
    f.focus(0, 0);
    await f.press("d", "d");
    await f.update([second]);
    let resolveSecond!: (item: StockItem) => void;
    const secondResponse = new Promise<StockItem>((resolve) => {
      resolveSecond = resolve;
    });
    f.api.cancel.mockImplementationOnce(() => secondResponse);
    f.focus(1, 0);
    await f.press("d", "d");
    const cancelled = { ...second, state: "cancelled" as const };
    await f.update([cancelled]);
    await f.press("u");
    expect(f.api.restore.mock.calls).toEqual([]);
    expect(f.controller.snapshot().notice?.message).toBe(
      "取り消しの結果を確認してから u で戻せます",
    );
    await act(async () => resolveSecond(cancelled));
    await f.press("u");
    expect(f.api.restore.mock.calls).toEqual([["b"]]);
  } finally {
    f.close();
  }
});

it("応答がなく別端末で取り消された同じ件をuで戻さず、後に自タブで成功した件だけを戻す", async () => {
  const first = stockSeed("a", "先の指示", 0);
  const second = stockSeed("b", "応答を失った指示", 1);
  const f = await fixture(conversationLines, "conversation", [first, second]);
  try {
    f.focus(0, 0);
    await f.press("d", "d");
    await f.update([second]);
    f.api.cancel.mockRejectedValueOnce(new Error("応答がありません"));
    f.focus(1, 0);
    await f.press("d", "d");
    await f.update([{ ...second, state: "cancelled" }]);
    await f.press("u");
    expect(f.api.restore.mock.calls).toEqual([]);
    expect(f.controller.snapshot().notice?.message).toBe(
      "このタブで取り消したことを確認できないため、戻せません",
    );
    await f.update([second]);
    f.focus(1, 0);
    await f.press("d", "d");
    await f.press("u");
    expect(f.api.restore.mock.calls).toEqual([["b"]]);
  } finally {
    f.close();
  }
});

it("後の取り消しが409で拒否されたときは先に成功した件を戻せる", async () => {
  const first = stockSeed("a", "先の指示", 0);
  const second = stockSeed("b", "送られた指示", 1);
  const f = await fixture(conversationLines, "conversation", [first, second]);
  try {
    f.focus(0, 0);
    await f.press("d", "d");
    await f.update([second]);
    f.api.cancel.mockRejectedValueOnce(
      new ConversationApiError(409, "conflict", "この指示はすでに送っています"),
    );
    f.api.restore.mockResolvedValueOnce(first);
    f.focus(1, 0);
    await f.press("d", "d");
    expect(f.controller.snapshot().notice?.message).toBe("この指示はすでに送っています");
    await f.press("u");
    expect(f.api.restore.mock.calls).toEqual([["a"]]);
  } finally {
    f.close();
  }
});
