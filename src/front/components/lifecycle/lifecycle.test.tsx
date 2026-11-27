import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { App } from "../../App";
import { createBrowserController } from "../../lib/browser";
import { createConversationApi } from "../../lib/conversation/api";
import type { ConversationEnvironment } from "../../lib/conversation/session";
import type { Snapshot } from "../../lib/conversation/types";
import { createConversationWorkspace } from "../../lib/conversation/workspace";
import { createLifecycleApi } from "../../lib/lifecycle/api";
import type { RealtimeSocket } from "../../lib/realtime";
import { parseRoute } from "../../lib/routes";
import { createNavigation } from "../../shell/navigation";

const mainTitle = "会話: 在庫の設計";
const closeTitle = "会話を締めくくる";
const listTitle = "会話とスレッドの一覧";
const searchTitle = "issue と会話を検索";

function conversation(id: string): Snapshot {
  const thread = id.startsWith("t");
  return {
    conversation: {
      id,
      projectId: "p1",
      projectName: "予約",
      kind: thread ? "thread" : id === "issue-conv" ? "issue" : "chat",
      issueId: id === "issue-conv" ? "i1" : null,
      parentConversationId: thread ? (id === "t-issue" ? "issue-conv" : "c1") : null,
      title: thread ? "在庫の質問" : "在庫の設計",
      cwd: "/workspace",
      worktree: null,
      runState: "idle",
      stopReason: null,
      resetsAt: null,
      lastSeq: thread ? 1 : 0,
      lastReadSeq: 0,
      lastPosition: null,
      closedAt: id === "closed" ? 90_000 : null,
    },
    draft: null,
    queue: [],
    pendingAnswers: null,
    pendingPermission: null,
    commands: [],
  };
}

const emptySummary = {
  working: false,
  outputs: {
    issues: { ok: true, items: [] },
    files: { ok: true, items: [] },
    commits: { ok: true, items: [], more: 0 },
    prs: { ok: false, error: "GitHub に接続できません" },
  },
  remaining: {
    uncommitted: { ok: true, items: [], more: 0 },
    unpushed: { ok: true, count: 0, upstream: true },
    stock: { questions: 0, instructions: 0 },
    runningThreads: [],
  },
  git: true,
};
type Request = { method: string; path: string; body: unknown };
const thread = (id: string, title: string, closedAt: number | null, lastActivityAt: number) => ({
  id,
  title,
  runState: "working",
  closedAt,
  lastActivityAt,
});
const results = [
  {
    type: "issue",
    id: "i1",
    projectId: "p1",
    number: 1,
    title: "在庫確認",
    state: "draft",
    lastActivityAt: 90_000,
  },
  {
    type: "conversation",
    kind: "chat",
    id: "c1",
    projectId: "p1",
    title: "在庫の設計",
    runState: "idle",
    closedAt: null,
    lastActivityAt: 80_000,
  },
  {
    type: "conversation",
    kind: "thread",
    id: "t1",
    projectId: "p1",
    parentId: "c1",
    title: "在庫の質問",
    runState: "working",
    closedAt: 69_000,
    lastActivityAt: 70_000,
  },
];

beforeEach(() => sessionStorage.clear());

function mount(
  url = "/conversations/c1",
  respond?: (request: Request) => Response | Promise<Response> | undefined,
  environment?: Partial<ConversationEnvironment>,
) {
  window.history.replaceState({}, "", url);
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = {
      path: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    const custom = await respond?.(request);
    if (custom) return custom;
    if (request.path.endsWith("/closing-summary")) return Response.json(emptySummary);
    if (request.path === "/api/projects")
      return Response.json({
        projects: [
          { id: "p1", name: "予約", conversations: [], issues: [] },
          { id: "p2", name: "棚卸", conversations: [], issues: [] },
        ],
      });
    if (request.path === "/api/projects/p1/conversations")
      return Response.json({
        conversations: [
          {
            id: "closed",
            title: "閉じた相談",
            runState: "idle",
            closedAt: 75_000,
            lastActivityAt: 75_000,
            threads: [
              thread("t2", "後の子スレッド", 77_000, 77_000),
              thread("t1", "先の子スレッド", null, 76_000),
            ],
          },
        ],
        issueThreads: [
          {
            issue: { id: "i1", number: 1, title: "issue の親" },
            threads: [thread("t-issue", "issue の子", null, 82_000)],
          },
        ],
      });
    if (request.path === "/api/projects/p2/conversations")
      return Response.json({
        conversations: [
          {
            id: "c2",
            title: "新しい相談",
            runState: "waiting_answer",
            closedAt: null,
            lastActivityAt: 90_000,
            threads: [],
          },
        ],
        issueThreads: [],
      });
    if (request.path.startsWith("/api/search?"))
      return Response.json({ results, truncated: false });
    if (request.method === "DELETE") return Response.json({ deleted: ["closed", "t1", "t2"] });
    if (request.path.endsWith("/close")) return Response.json({ closedAt: 100_000 });
    if (request.path.endsWith("/messages"))
      return Response.json({ result: "delivered", queueItem: null }, { status: 202 });
    if (request.path.includes("/events?")) {
      const events = request.path.includes("/t")
        ? [
            {
              seq: 1,
              type: "assistant_text",
              payload: { text: "在庫を確認しました", parent_tool_use_id: null },
              createdAt: 1,
            },
          ]
        : [];
      return Response.json({ events, lastSeq: events.length, hasMore: false });
    }
    const id = request.path.split("/").at(-1)!;
    return Response.json(conversation(id));
  };
  const navigation = createNavigation(parseRoute(url), () => {});
  const browser = createBrowserController(window, navigation.open);
  const send = vi.fn<(data: string) => void>();
  const socket: RealtimeSocket = {
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send,
    close: vi.fn(),
  };
  const openExternal = vi.fn<(url: string) => void>();
  const workspace = createConversationWorkspace(
    createConversationApi(fetcher),
    browser.controller,
    {
      clientId: "test",
      id: () => "msg",
      now: () => 100_000,
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      ...environment,
    },
    () => socket,
    { lifecycle: { api: createLifecycleApi(fetcher), openExternal } },
  );
  const stop = workspace.start();
  const ui = render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <App
        controller={browser.controller}
        navigation={navigation}
        loadScreen={workspace.loadScreen}
        renderRight={workspace.renderRight}
      />
    </SWRConfig>,
  );
  return {
    controller: browser.controller,
    requests,
    socket,
    send,
    openExternal,
    close() {
      ui.unmount();
      stop();
      browser.dispose();
    },
  };
}

function editor(region: string): EditorView {
  return EditorView.findFromDOM(
    screen.getByRole("region", { name: region }).querySelector(".cm-editor")!,
  )!;
}

function key(view: EditorView, ...keys: string[]) {
  act(() => {
    for (const key of keys) fireEvent.keyDown(view.contentDOM, { key });
  });
}
function choose(region: string, text: string) {
  const view = editor(region);
  const line = Array.from({ length: view.state.doc.lines }, (_, index) =>
    view.state.doc.line(index + 1),
  ).find((line) => line.text.includes(text));
  expect(line).toBeDefined();
  act(() => {
    view.contentDOM.focus();
    view.dispatch({ selection: { anchor: line!.from } });
  });
  return view;
}
async function find(region: string, text: string) {
  await screen.findByRole("region", { name: region });
  await waitFor(() => expect(editor(region).state.doc.toString()).toContain(text));
}

it.each(["Enter", "q"])("締めくくりを %s でやめ、閉じずに指示を書ける", async (cancel) => {
  const app = mount();
  try {
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "やめて会話に戻る");
    const view = choose(closeTitle, "やめて会話に戻る");
    key(view, cancel);
    expect(screen.queryByRole("region", { name: closeTitle })).toBeNull();
    key(editor(mainTitle), "i");
    expect(screen.getByRole("textbox", { name: "指示" })).toBeVisible();
    expect(app.requests.filter((r) => r.method === "POST" && r.path.endsWith("/close"))).toEqual(
      [],
    );
  } finally {
    app.close();
  }
});

it("作業中・取得できない項目・空の項目を見せ、停止を指定して閉じる", async () => {
  const app = mount("/conversations/c1", (request) =>
    request.path.endsWith("/closing-summary")
      ? Response.json({ ...emptySummary, working: true })
      : undefined,
  );
  try {
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "AI を止めて、この会話を閉じる");
    const body = editor(closeTitle).state.doc.toString();
    expect(body.split("\n")[0]).toBe("AI が作業中です。閉じるには AI を止めます");
    expect(body).toContain("取得できませんでした (GitHub に接続できません)");
    expect(body).toContain("なし");
    key(choose(closeTitle, "AI を止めて、この会話を閉じる"), "Enter");
    await screen.findByRole("region", { name: "一覧" });
    expect(app.requests.filter((r) => r.method === "POST")).toEqual([
      { method: "POST", path: "/api/conversations/c1/close", body: { stopIfWorking: true } },
    ]);
    expect(screen.queryByRole("region", { name: closeTitle })).toBeNull();
  } finally {
    app.close();
  }
});

it.each([
  ["在庫確認", "/issues/i1/edit"],
  ["在庫の設計", "/conversations/c1"],
  ["在庫の質問", "/conversations/c1?thread=t1"],
])("検索結果「%s」で Enter を押すと対応する対象を開く", async (title, path) => {
  const app = mount();
  try {
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "f");
    const command = screen.getByRole("textbox", { name: "コマンド" });
    expect(command).toHaveValue("find ");
    fireEvent.change(command, { target: { value: "find 在庫" } });
    fireEvent.keyDown(command, { key: "Enter" });
    await find(searchTitle, title);
    key(choose(searchTitle, title), "Enter");
    await waitFor(() => expect(location.pathname + location.search).toBe(path));
    expect(app.requests).toContainEqual({
      method: "GET",
      path: "/api/search?q=%E5%9C%A8%E5%BA%AB",
      body: null,
    });
    if (path.includes("thread=")) {
      const panel = await screen.findByRole("region", { name: "スレッド: 在庫の質問" });
      await within(panel).findByText("在庫を確認しました");
    }
  } finally {
    app.close();
  }
});

it("プロジェクト横断で親子を並べ、y 以外では削除せず、y で選んだ会話だけを削除する", async () => {
  const app = mount();
  try {
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "b");
    await find(listTitle, "後の子スレッド");
    const rows = editor(listTitle)
      .state.doc.toString()
      .split("\n")
      .filter((line) => line.includes("秒前"));
    expect(rows).toEqual([
      "会話: 新しい相談  判断待ち  棚卸  10秒前",
      "#1 issue の親    予約  18秒前",
      "  スレッド: issue の子  作業中  予約  18秒前",
      "会話: 閉じた相談  閉じた  予約  25秒前",
      "  スレッド: 先の子スレッド  作業中  予約  24秒前",
      "  スレッド: 後の子スレッド  終了  予約  23秒前",
    ]);
    const view = choose(listTitle, "会話: 閉じた相談");
    key(view, "d", "d");
    expect(screen.getByLabelText("操作の確認")).toHaveTextContent(
      "「閉じた相談」とそのスレッドを削除しますか?",
    );
    key(view, "Escape");
    expect(screen.getByRole("alert")).toHaveTextContent("やめました");
    expect(app.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    key(view, "d", "d", "y");
    await waitFor(() =>
      expect(app.requests.filter((r) => r.method === "DELETE")).toEqual([
        { method: "DELETE", path: "/api/conversations/closed", body: null },
      ]),
    );
  } finally {
    app.close();
  }
});

it("作業開始で close が 409 のときに最新の確認を表示し、閉じるには改めて選ぶ", async () => {
  let working = false;
  const app = mount("/conversations/c1", (request) => {
    if (request.path.endsWith("/closing-summary"))
      return Response.json({ ...emptySummary, working });
    if (request.path.endsWith("/close")) {
      working = true;
      return Response.json(
        { error: { code: "conflict", message: "AI が作業中です。止めて閉じるか、やめてください" } },
        { status: 409 },
      );
    }
  });
  try {
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "この会話を閉じる");
    key(choose(closeTitle, "この会話を閉じる"), "Enter");
    await find(closeTitle, "AI を止めて、この会話を閉じる");
    expect(app.requests.filter(({ path }) => path.endsWith("/close"))).toEqual([
      { method: "POST", path: "/api/conversations/c1/close", body: { stopIfWorking: false } },
    ]);
    expect(location.pathname).toBe("/conversations/c1");
  } finally {
    app.close();
  }
});

it("Git の管理外でも締めくくりの操作ができ、503 では元の会話と確認を残す", async () => {
  const app = mount("/conversations/c1", (request) => {
    if (request.path.endsWith("/closing-summary"))
      return Response.json({
        ...emptySummary,
        git: false,
        outputs: { issues: emptySummary.outputs.issues, files: emptySummary.outputs.files },
        remaining: { stock: { questions: 2, instructions: 1 }, runningThreads: [] },
      });
    if (request.path.endsWith("/close"))
      return Response.json(
        {
          error: { code: "runner_unavailable", message: "ランナーにつながりません" },
        },
        { status: 503 },
      );
  });
  try {
    await screen.findByRole("region", { name: mainTitle });
    await act(async () => app.controller.command("close"));
    await find(closeTitle, "この会話を閉じる");
    const body = editor(closeTitle).state.doc.toString();
    expect(body.match(/Git の管理外/g)).toHaveLength(4);
    expect(body).toContain("指示 1 件 / 質問 2 件");
    key(choose(closeTitle, "この会話を閉じる"), "Enter");
    expect(await screen.findByRole("alert")).toHaveTextContent("ランナーにつながりません");
    expect(location.pathname).toBe("/conversations/c1");
    expect(screen.getByRole("region", { name: closeTitle })).toBeVisible();
  } finally {
    app.close();
  }
});

it("issue の会話を締めくくるキーは取り下げ先を案内し、確認の API を呼ばない", async () => {
  const app = mount("/conversations/issue-conv");
  try {
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "z");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "プロジェクトの画面で dd を押して取り下げます",
    );
    expect(screen.queryByRole("region", { name: closeTitle })).toBeNull();
    expect(app.requests.filter(({ path }) => path.endsWith("/closing-summary"))).toEqual([]);
  } finally {
    app.close();
  }
});

it("閉じた会話を開いても読み取りだけで、入力欄から送ったときに再開を知らせる", async () => {
  const app = mount("/conversations/closed", (request) => {
    if (request.path.endsWith("/draft")) return Response.json({ draft: null, applied: true });
  });
  try {
    await screen.findByRole("region", { name: mainTitle });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "閉じた会話です。続きを書いて送ると再開します",
    );
    expect(app.requests.map(({ method }) => method).every((method) => method === "GET")).toBe(true);
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "やめて会話に戻る");
    key(editor(closeTitle), "q");
    expect(app.requests.map(({ method }) => method).every((method) => method === "GET")).toBe(true);
    key(editor(mainTitle), "i");
    const input = EditorView.findFromDOM(screen.getByRole("textbox", { name: "指示" }))!;
    act(() => input.dispatch({ changes: { from: 0, insert: "続きをお願いします" } }));
    key(input, "Escape", "Enter");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "送りました。会話を再開し、一覧に戻します",
      ),
    );
    expect(app.requests.find(({ path }) => path.endsWith("/messages"))?.body).toMatchObject({
      text: "続きをお願いします",
    });
  } finally {
    app.close();
  }
});

it("issue の下のスレッドは元の会話を特定し、右に記録を出す", async () => {
  const app = mount("/convs");
  try {
    await find(listTitle, "issue の子");
    key(choose(listTitle, "issue の子"), "Enter");
    await waitFor(() =>
      expect(location.pathname + location.search).toBe("/conversations/issue-conv?thread=t-issue"),
    );
    const preview = await screen.findByRole("region", { name: "スレッド: 在庫の質問" });
    expect(await within(preview).findByText("在庫を確認しました")).toBeVisible();
    await act(async () => app.controller.navigate("/conversations/c1"));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "スレッド: 在庫の質問" })).toBeNull(),
    );
  } finally {
    app.close();
  }
});

it("検索を開いたまま inbox の配信だけを受けて結果を読み直す", async () => {
  let changed = false;
  const app = mount("/search?q=在庫", (request) => {
    if (request.path.startsWith("/api/search?")) {
      return Response.json(
        changed
          ? { results: [{ ...results[0], title: "在庫の追加" }], truncated: true }
          : { results: [], truncated: false },
      );
    }
  });
  try {
    act(() => app.socket.onopen?.());
    await find(searchTitle, "一致する issue と会話はありません");
    changed = true;
    act(() =>
      app.socket.onmessage?.({
        data: JSON.stringify({ topic: "inbox", seq: 1, type: "changed", payload: {} }),
      }),
    );
    await find(searchTitle, "在庫の追加");
    expect(editor(searchTitle).state.doc.toString()).toContain("(100 件まで)");
  } finally {
    app.close();
  }
});

it("締めくくりの成果の行からコミットをコピーして PR を開く", async () => {
  const url = "https://github.com/example/project/pull/4";
  const app = mount("/conversations/c1", (request) => {
    if (request.path.endsWith("/closing-summary"))
      return Response.json({
        ...emptySummary,
        outputs: {
          ...emptySummary.outputs,
          commits: { ok: true, items: [{ hash: "a7a8a9", subject: "入力をそろえる" }], more: 1 },
          prs: { ok: true, items: [{ number: 4, title: "変更を確認", url, state: "OPEN" }] },
        },
      });
  });
  const write = vi.fn<(value: string) => Promise<void>>(async () => {});
  app.controller.options.clipboard = {
    secure: true,
    write,
    fallback: () => false,
    notify: vi.fn(),
  };
  try {
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "ほか 1 件");
    key(choose(closeTitle, "入力をそろえる"), "Enter");
    await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith("a7a8a9"));
    key(choose(closeTitle, "変更を確認"), "Enter");
    expect(app.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(location.pathname).toBe("/conversations/c1");
  } finally {
    app.close();
  }
});

it("確認を表示中に stock と threads の配信を受け、作業の残りを読み直す", async () => {
  let instructions = 0;
  const app = mount("/conversations/c1", (request) => {
    if (request.path.endsWith("/closing-summary"))
      return Response.json({
        ...emptySummary,
        remaining: { ...emptySummary.remaining, stock: { questions: 0, instructions } },
      });
  });
  try {
    act(() => app.socket.onopen?.());
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "ストック  なし");
    instructions = 2;
    act(() =>
      app.socket.onmessage?.({
        data: JSON.stringify({
          topic: "conversation:c1",
          seq: 0,
          type: "changed",
          payload: { parts: ["stock", "threads"] },
        }),
      }),
    );
    await find(closeTitle, "ストック  指示 2 件 / 質問 0 件");
  } finally {
    app.close();
  }
});

it("確認を読み込む間はメニュー番号を表示せず q で会話へ戻れる", async () => {
  let resolveSummary: (response: Response) => void = () => {};
  const summary = new Promise<Response>((resolve) => {
    resolveSummary = resolve;
  });
  const app = mount("/conversations/c1", (request) =>
    request.path.endsWith("/closing-summary") ? summary : undefined,
  );
  try {
    await screen.findByRole("region", { name: mainTitle });
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "q で会話に戻る");
    expect(screen.getByRole("region", { name: closeTitle }).querySelector(".cm-menu")).toBeNull();
    key(editor(closeTitle), "q");
    await act(async () => resolveSummary(Response.json(emptySummary)));
    expect(screen.queryByRole("region", { name: closeTitle })).toBeNull();
    expect(app.requests.filter(({ method }) => method === "POST")).toEqual([]);
  } finally {
    app.close();
  }
});

it.each([true, false])("作業状態が %s に変わる配信でも、選択した取消しを実行する", async (next) => {
  let working = !next;
  const app = mount("/conversations/c1", (request) =>
    request.path.endsWith("/closing-summary")
      ? Response.json({ ...emptySummary, working })
      : undefined,
  );
  try {
    act(() => app.socket.onopen?.());
    await find(mainTitle, "");
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "やめて会話に戻る");
    const view = choose(closeTitle, "やめて会話に戻る");
    working = next;
    act(() =>
      app.socket.onmessage?.({
        data: JSON.stringify({
          topic: "conversation:c1",
          seq: 0,
          type: "changed",
          payload: { parts: ["stock"] },
        }),
      }),
    );
    await waitFor(() => expect(view.state.doc.toString().includes("AI が作業中です")).toBe(next));
    key(view, "Enter");
    expect(screen.queryByRole("region", { name: closeTitle })).toBeNull();
    expect(app.requests.filter(({ method }) => method === "POST")).toEqual([]);
  } finally {
    app.close();
  }
});

it.each([false, true])(
  "作業開始の配信で古い停止番号を無効にし、押し直すと実行する（主へ移動: %s）",
  async (moveToMain) => {
    let working = false;
    const app = mount("/conversations/c1", (request) =>
      request.path.endsWith("/closing-summary")
        ? Response.json({ ...emptySummary, working })
        : undefined,
    );
    try {
      act(() => app.socket.onopen?.());
      await find(mainTitle, "");
      key(editor(mainTitle), " ", "z");
      await find(closeTitle, "この会話を閉じる");
      const view = choose(closeTitle, "この会話を閉じる");
      key(view, "1");
      expect(screen.getByRole("status")).toHaveTextContent("1 Enter");
      const main = editor(mainTitle);
      if (moveToMain) {
        act(() => main.contentDOM.focus());
        key(main, "3");
        expect(screen.getByRole("status")).toHaveTextContent("3 Enter");
      }
      working = true;
      act(() =>
        app.socket.onmessage?.({
          data: JSON.stringify({
            topic: "conversation:c1",
            seq: 0,
            type: "changed",
            payload: { parts: ["stock"] },
          }),
        }),
      );
      await find(closeTitle, "AI を止めて、この会話を閉じる");
      if (moveToMain) {
        expect(main.contentDOM).toHaveFocus();
        expect(screen.getByRole("status")).toHaveTextContent("3 Enter");
        key(main, "Enter");
        expect(screen.getByRole("alert")).toHaveTextContent("3 番の操作は、この画面にありません");
        choose(closeTitle, "worktree とファイルは消しません。");
      }
      key(view, "Enter");
      expect(app.requests.filter(({ method }) => method === "POST")).toEqual([]);
      expect(screen.getByRole("region", { name: closeTitle })).toBeVisible();
      key(view, "1", "Enter");
      await waitFor(() =>
        expect(app.requests.filter(({ method }) => method === "POST")).toEqual([
          { method: "POST", path: "/api/conversations/c1/close", body: { stopIfWorking: true } },
        ]),
      );
    } finally {
      app.close();
    }
  },
);

it("右の締めくくりを更新しても、主の選択とコピーの案内が残る", async () => {
  let working = false;
  const app = mount("/conversations/c1", (request) => {
    if (request.path.endsWith("/closing-summary"))
      return Response.json({ ...emptySummary, working });
    if (request.path.includes("/events?"))
      return Response.json({
        lastSeq: 1,
        hasMore: false,
        events: [
          {
            seq: 1,
            type: "assistant_text",
            payload: { text: "在庫を確認しました", parent_tool_use_id: null },
            createdAt: 1,
          },
        ],
      });
  });
  const write = vi.fn<(value: string) => Promise<void>>(async () => {});
  app.controller.options.clipboard = {
    secure: true,
    write,
    fallback: () => false,
    notify: vi.fn(),
  };
  try {
    act(() => app.socket.onopen?.());
    await find(mainTitle, "在庫を確認しました");
    key(choose(mainTitle, "在庫を確認しました"), " ", "z");
    await find(closeTitle, "この会話を閉じる");
    key(choose(closeTitle, "worktree とファイルは消しません。"), "v", "1");
    const status = within(screen.getByRole("status"));
    expect(status.getByText("VISUAL", { exact: true })).toBeVisible();

    const main = choose(mainTitle, "在庫を確認しました");
    key(main, "v", "l");
    expect(status.getByText("VISUAL", { exact: true })).toBeVisible();
    working = true;
    act(() =>
      app.socket.onmessage?.({
        data: JSON.stringify({
          topic: "conversation:c1",
          seq: 1,
          type: "state",
          payload: { run_state: "working", stop_reason: null, resets_at: null },
        }),
      }),
    );
    await find(closeTitle, "AI を止めて、この会話を閉じる");
    expect(main.contentDOM).toHaveFocus();
    expect(status.getByText("VISUAL", { exact: true })).toBeVisible();
    expect(status.getByText("コピー", { exact: true })).toBeVisible();
    key(main, "y");
    await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith("在庫"));
    expect(status.getByText("NORMAL", { exact: true })).toBeVisible();
  } finally {
    app.close();
  }
});

it.each([
  ["/convs", listTitle, "後の子スレッド"],
  ["/search?q=在庫", searchTitle, "在庫の質問"],
  ["/conversations/c1?thread=t1", "スレッド: 在庫の質問", "在庫を確認しました"],
])("%s の再読込で実行を読み込んでからカーソルを復元する", async (url, title, target) => {
  const first = mount(url);
  try {
    await find(title, target);
    const view = choose(title, target);
    act(() => view.dispatch({ selection: { anchor: view.state.selection.main.head + 3 } }));
  } finally {
    first.close();
  }
  const second = mount(url);
  try {
    await find(title, target);
    const view = editor(title);
    const head = view.state.selection.main.head;
    expect(view.state.doc.lineAt(head).text).toContain(target);
    expect(head - view.state.doc.lineAt(head).from).toBe(3);
  } finally {
    second.close();
  }
});

it("締めくくりを開いたまま再読込すると主に戻り、すぐ指示を書ける", async () => {
  const first = mount();
  try {
    await find(mainTitle, "");
    key(editor(mainTitle), " ", "z");
    await find(closeTitle, "やめて会話に戻る");
    expect(editor(closeTitle).contentDOM).toHaveFocus();
  } finally {
    first.close();
  }
  const second = mount();
  try {
    await find(mainTitle, "");
    const main = editor(mainTitle);
    expect(main.contentDOM).toHaveFocus();
    key(main, "i");
    expect(screen.getByRole("textbox", { name: "指示" })).toBeVisible();
  } finally {
    second.close();
  }
});

it("右のスレッドの表示・再接続・終了を閲覧中の会話として配信する", async () => {
  const scheduled = new Map<number, () => void>();
  const app = mount("/conversations/c1?thread=t1", undefined, {
    schedule(callback, delay) {
      scheduled.set(delay, callback);
      return () => {
        if (scheduled.get(delay) === callback) scheduled.delete(delay);
      };
    },
  });
  const shown = () =>
    app.send.mock.calls
      .map(([wire]) => JSON.parse(wire))
      .filter((message) => message.op === "shown")
      .at(-1)
      ?.topics?.sort();
  try {
    act(() => app.socket.onopen?.());
    await find(mainTitle, "");
    const threadTitle = "スレッド: 在庫の質問";
    await find(threadTitle, "在庫を確認しました");
    expect(editor(threadTitle).contentDOM).toHaveFocus();
    expect(shown()).toEqual(["conversation:c1", "conversation:t1"]);
    act(() => {
      app.socket.onclose?.();
      scheduled.get(500)?.();
      app.socket.onopen?.();
    });
    expect(shown()).toEqual(["conversation:c1", "conversation:t1"]);
    key(editor(threadTitle), "q");
    expect(shown()).toEqual(["conversation:c1"]);
    expect(editor(mainTitle).contentDOM).toHaveFocus();
  } finally {
    app.close();
  }
});

it("一覧の経過表示を環境の30秒タイマーで更新し、画面を離れると解放する", async () => {
  let now = 100_000;
  const scheduled = new Set<() => void>();
  const app = mount("/convs", undefined, {
    now: () => now,
    schedule(callback, delay) {
      if (delay === 30_000) scheduled.add(callback);
      return () => scheduled.delete(callback);
    },
  });
  try {
    await find(listTitle, "10秒前");
    const [tick] = scheduled;
    expect(scheduled.size).toBe(1);
    now += 30_000;
    act(() => {
      scheduled.delete(tick);
      tick();
    });
    await find(listTitle, "40秒前");
    expect(scheduled.size).toBe(1);
  } finally {
    app.close();
  }
  expect(scheduled.size).toBe(0);
});

it("一覧・検索の操作をステータス行に示し、削除の確認では y/n を優先する", async () => {
  const list = mount("/convs");
  try {
    await find(listTitle, "閉じた相談");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Enter 開く");
    expect(status).toHaveTextContent("d d 削除");
    expect(status).toHaveTextContent("- 戻る");
    key(choose(listTitle, "閉じた相談"), "d", "d");
    expect(status).toHaveTextContent("y 実行する");
    expect(status).toHaveTextContent("n やめる");
    expect(status).not.toHaveTextContent("d d 削除");
  } finally {
    list.close();
  }
  const search = mount("/search?q=在庫");
  try {
    await find(searchTitle, "在庫の質問");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Enter 開く");
    expect(status).toHaveTextContent("- 戻る");
    expect(status).not.toHaveTextContent("d d 削除");
  } finally {
    search.close();
  }
});
