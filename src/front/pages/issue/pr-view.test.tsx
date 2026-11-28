import { StrictMode } from "react";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SWRConfig } from "swr";
import type { PrResponse, PublishResponse } from "../../../shared/api/pr";
import type { ServerMessage } from "../../../shared/ws";
import type { StockItem } from "../../../shared/stock";
import { BufferController } from "../../buffer/controller";
import { Layout } from "../../buffer/Layout";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import { ConversationApiError, createConversationApi } from "../../lib/conversation/api";
import { ConversationSession } from "../../lib/conversation/session";
import { createConversationWorkspace } from "../../lib/conversation/workspace";
import type { RealtimeSocket } from "../../lib/realtime";
import type { Snapshot } from "../../lib/conversation/types";
import type { StockApi } from "../../lib/stock/api";
import { createStockWorkspace } from "../../lib/stock/workspace";
import { issueView } from "./issue.test-support";
import type { PrApi } from "./pr-api";
import { PrView } from "./pr-view";
import { base, check, file, sha } from "./pr.test-support";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((dispose) => dispose());
});
const snapshot: Snapshot = {
  conversation: {
    id: "c",
    projectId: "p",
    projectName: "予約",
    title: "#12 の実装",
    kind: "impl",
    issueId: "i",
    parentConversationId: null,
    cwd: "/repo",
    worktree: null,
    runState: "idle",
    stopReason: null,
    closedAt: null,
    resetsAt: null,
    lastSeq: 0,
    lastReadSeq: 0,
    lastPosition: null,
  },
  draft: null,
  queue: [],
  pendingAnswers: null,
  pendingPermission: null,
  commands: [],
};
const item = (
  id: string,
  kind: StockItem["kind"] = "instruction",
  state: StockItem["state"] = "stocked",
): StockItem => ({
  id,
  conversationId: "c",
  kind,
  text: `指示 ${id}`,
  state,
  stale: false,
  quote: { kind: "terminal", mode: "line", text: "位置" },
  sentAt: state === "sent" ? 1 : null,
  sentSeq: state === "sent" ? 2 : null,
  thread: null,
  githubCommentUrl: null,
});
const response = { ...base, files: [file] };

async function fixture(
  initial: PrResponse = response,
  initialStock: StockItem[] = [],
  connectDrafts = false,
  strict = false,
  {
    loadFromWorkspace = false,
    pendingPr,
  }: {
    loadFromWorkspace?: boolean;
    pendingPr?: Promise<PrResponse>;
  } = {},
) {
  let data = initial;
  let items = initialStock;
  const controller = new BufferController({ url: "/issues/i/diff" });
  const notify = vi.fn<(message: string, kind: string) => void>();
  controller.options.notify = notify;
  const sent = vi.fn(async () => ({ result: "delivered" as const, queueItem: null }));
  const saveDraft = vi.fn<ReturnType<typeof createConversationApi>["saveDraft"]>(
    async (_id, { text, images, clientId, editedAt }) => ({
      draft: { text, images, updatedBy: clientId, updatedAt: editedAt },
      applied: true,
    }),
  );
  const getConversation = vi.fn(async (): Promise<Snapshot> => snapshot);
  const getEvents = vi.fn<ReturnType<typeof createConversationApi>["events"]>(async () => ({
    events: [],
    lastSeq: 0,
    hasMore: false,
  }));
  const conversationApi = {
    ...createConversationApi(async () => {
      throw new Error("予期しない会話 API");
    }),
    get: getConversation,
    events: getEvents,
    saveDraft,
    send: sent,
  };
  let testTime = 0;
  const timers = new Map<() => void, number>();
  const schedule = (run: () => void, ms: number) => {
    timers.set(run, testTime + ms);
    return () => {
      timers.delete(run);
    };
  };
  const env = { clientId: "tab", id: () => "message-id", now: () => testTime, schedule };
  const session = new ConversationSession("c", conversationApi, controller, env, {
    initial: snapshot,
  });
  const stockApi = {
    list: vi.fn(async () => items),
    threads: async () => [],
    add: vi.fn<StockApi["add"]>(async (_, body) => {
      const next = { ...item("new"), ...body };
      items = [...items, next];
      return next;
    }),
    edit: async () => item("edit"),
    cancel: async () => item("cancel"),
    restore: async () => item("restore"),
    send: async () => ({ instructions: { count: 0, delivery: null }, questions: [] }),
    propose: async () => null,
    close: async () => ({ id: "thread", closedAt: 0 }),
    finish: async () => ({ item: item("finish"), thread: { id: "thread", closedAt: 0 } }),
  } satisfies StockApi;
  const issueChanges = new Set<() => void>();
  const stockChanges = new Set<(msg?: ServerMessage) => void>();
  const subscribe: LifecycleFeed = (topic, callback) => {
    const listeners = topic === "issue:i" ? issueChanges : stockChanges;
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  };
  const stock = createStockWorkspace({
    api: stockApi,
    controller,
    conversations: conversationApi,
    env,
    subscribe,
    showConversation: () => () => {},
    queuedId: () => undefined,
    openFile: () => {},
  });
  disposals.push(stock.start());
  const published: PublishResponse = {
    reviewUrl: "https://github.com/example/review",
    published: [{ stockId: "a", url: "https://github.com/example/comment", placement: "body" }],
    skipped: [{ stockId: "b", reason: "already_published" }],
  };
  const api = {
    get: vi.fn(async () => data),
    allowMerge: vi.fn<PrApi["allowMerge"]>(async () => ({ state: "implementing" })),
    publish: vi.fn<PrApi["publish"]>(async (_, ids) => {
      items = items.map((entry) =>
        ids.includes(entry.id) && entry.id === "a"
          ? { ...entry, githubCommentUrl: published.published[0].url }
          : entry,
      );
      return {
        ...published,
        skipped: published.skipped.filter(({ stockId }) => ids.includes(stockId)),
      };
    }),
  } satisfies PrApi;
  if (pendingPr) api.get.mockReturnValueOnce(pendingPr);
  const sockets: (RealtimeSocket & { sent: unknown[] })[] = [];
  const conversations = connectDrafts
    ? createConversationWorkspace(conversationApi, controller, env, () => {
        const socket: RealtimeSocket & { sent: unknown[] } = {
          sent: [],
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          send(data) {
            this.sent.push(JSON.parse(data));
          },
          close() {
            this.onclose?.();
          },
        };
        sockets.push(socket);
        return socket;
      })
    : undefined;
  if (conversations) disposals.push(conversations.start());
  const services = {
    api,
    stock,
    openExternal: () => {},
    trackDraft: conversations?.trackReviewDraft ?? (() => {}),
    watchDraft: conversations?.watchReviewDraft ?? (() => () => {}),
    schedule,
  };
  const advance = async (ms: number) => {
    await act(async () => {
      testTime += ms;
      for (const [run, at] of timers) {
        if (at > testTime) continue;
        timers.delete(run);
        run();
      }
    });
  };
  const swr = { provider: () => new Map() };
  const screenWithReview = (open: boolean) => (
    <SWRConfig value={swr}>
      <Layout
        controller={controller}
        renderRight={(view) => stock.right(view)}
        main={
          open ? (
            <PrView
              issue={issueView({ state: "stopped", stopReason: "merge_confirm" })}
              project={{ path: "/repo", usesGithub: true }}
              controller={controller}
              services={services}
              subscribe={subscribe}
              loadConversation={
                loadFromWorkspace && conversations
                  ? conversations.loadConversation
                  : async () => session
              }
              title="PR の差分"
              tabs={null}
              positionKey="pr"
            />
          ) : null
        }
      />
    </SWRConfig>
  );
  const scopedScreen = (open: boolean) =>
    strict ? <StrictMode>{screenWithReview(open)}</StrictMode> : screenWithReview(open);
  const mounted = await act(async () => render(scopedScreen(true)));
  const press = async (...keys: string[]) => {
    await act(async () => {
      for (const key of keys) fireEvent.keyDown(document.activeElement!, { key });
    });
  };
  const cursor = (text: string, side = "main") => {
    const index = controller.windowLines(side).findIndex((line) => line.text.includes(text));
    expect(index).toBeGreaterThanOrEqual(0);
    act(() => {
      controller.focus(side);
      controller.place(side, index, 0);
    });
  };
  const enter = async (text: string) => {
    cursor(text);
    await press("Enter");
  };
  const submit = async (text: string) => {
    const input = screen.getByRole("textbox", { name: /^指示$/ });
    const editor = EditorView.findFromDOM(input.closest(".cm-editor")!)!;
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }));
    await press("Escape", "Enter");
  };
  return {
    api,
    stockApi,
    advance,
    sockets,
    session,
    getEvents,
    getConversation,
    loadConversation: conversations?.loadConversation,
    subscribeSession: conversations?.subscribeIssueConversation,
    subscribeProbe: conversations?.subscribeChanges,
    setStock(next: StockItem[]) {
      items = next;
    },
    reloadStock: () =>
      act(async () =>
        stockChanges.forEach((receive) =>
          receive({
            topic: "conversation:c",
            seq: 1,
            type: "changed",
            payload: { parts: ["stock"] },
          }),
        ),
      ),
    subscribeConversation: () => conversations?.subscribeIssueConversation(session),
    saveDraft,
    sent,
    controller,
    notify,
    mounted,
    press,
    cursor,
    enter,
    submit,
    set(next: PrResponse) {
      data = next;
    },
    issueChanged: () => act(async () => issueChanges.forEach((change) => change())),
    reopen: async () => {
      await act(async () => mounted.rerender(scopedScreen(false)));
      await act(async () => mounted.rerender(scopedScreen(true)));
    },
  };
}

it("GitHub から読み直す行の Enter と issue の配信で、最新の PR を表示する", async () => {
  const f = await fixture();
  f.set({ ...response, pr: { ...response.pr!, title: "更新後の予約" } });
  await f.enter("GitHub から読み直す");
  await screen.findByText("PR #128 更新後の予約", { exact: true });
  expect(f.api.get).toHaveBeenCalledTimes(2);

  f.set({ ...response, pr: { ...response.pr!, title: "配信後の予約" } });
  await f.issueChanged();
  await screen.findByText("PR #128 配信後の予約", { exact: true });
});

it("StrictMode の同じ表示の取得は一度で、すぐ開き直したときは改めて取得する", async () => {
  const f = await fixture(response, [], false, true);
  await screen.findByText("PR #128 予約カレンダーに祝日を表示する", { exact: true });
  expect(f.api.get).toHaveBeenCalledTimes(1);
  f.set({ ...response, pr: { ...response.pr!, title: "開き直した版" } });
  await f.reopen();
  await screen.findByText("PR #128 開き直した版", { exact: true });
  expect(f.api.get).toHaveBeenCalledTimes(2);
});

it("差分をすぐ開き直したときも、issue の配信を待たず新しい版を取得する", async () => {
  const f = await fixture();
  f.set({ ...response, pr: { ...response.pr!, title: "再表示した PR" } });
  await f.reopen();
  await screen.findByText("PR #128 再表示した PR", { exact: true });
  expect(f.api.get).toHaveBeenCalledTimes(2);
});

it.each([
  { mode: "通常", strict: false },
  { mode: "StrictMode", strict: true },
])("$mode で前の GET が未完了でも開き直した差分は最新の応答を使う", async ({ strict }) => {
  let finish!: (value: PrResponse) => void;
  const pendingPr = new Promise<PrResponse>((resolve) => {
    finish = resolve;
  });
  const f = await fixture(response, [], false, strict, { pendingPr });
  expect(f.api.get).toHaveBeenCalledExactlyOnceWith("i");
  f.set({ ...response, pr: { ...response.pr!, title: "開き直した最新の PR" } });
  await f.reopen();
  const requests = f.api.get.mock.calls.length;
  await act(async () => finish(response));

  expect(requests).toBe(2);
  expect(screen.getByText("PR #128 開き直した最新の PR", { exact: true })).toBeVisible();
  expect(
    screen.queryByText("PR #128 予約カレンダーに祝日を表示する", { exact: true }),
  ).not.toBeInTheDocument();
});

it.each([
  { mode: "通常", strict: false },
  { mode: "StrictMode", strict: true },
])("$mode で開き直した PR を表示した後、前の表示の 502 は表示を変えない", async ({ strict }) => {
  let rejectOld!: (error: Error) => void;
  const pendingPr = new Promise<PrResponse>((_, reject) => {
    rejectOld = reject;
  });
  const f = await fixture(response, [], false, strict, { pendingPr });
  f.set({ ...response, pr: { ...response.pr!, title: "新しく開いた PR" } });
  await f.reopen();
  expect(f.api.get.mock.calls).toEqual([["i"], ["i"]]);
  await screen.findByText("PR #128 新しく開いた PR", { exact: true });

  await act(async () =>
    rejectOld(new ConversationApiError(502, "github_unavailable", "前の表示の取得失敗")),
  );

  expect(screen.getByText("PR #128 新しく開いた PR", { exact: true })).toBeVisible();
  expect(screen.queryByText("前の表示の取得失敗", { exact: true })).not.toBeInTheDocument();
});

it("StrictMode で開き直した差分は、最新の GET を待つ間も閉じた表示の成功を表示しない", async () => {
  let resolveOld!: (data: PrResponse) => void;
  let resolveLatest!: (data: PrResponse) => void;
  const pendingPr = new Promise<PrResponse>((resolve) => {
    resolveOld = resolve;
  });
  const latest = new Promise<PrResponse>((resolve) => {
    resolveLatest = resolve;
  });
  const f = await fixture(response, [], false, true, { pendingPr });
  f.api.get.mockReturnValueOnce(latest);
  await f.reopen();
  expect(f.api.get.mock.calls).toEqual([["i"], ["i"]]);

  await act(async () => resolveOld(response));
  expect(
    screen.queryByText("PR #128 予約カレンダーに祝日を表示する", { exact: true }),
  ).not.toBeInTheDocument();
  await act(async () => resolveLatest({ ...response, pr: { ...response.pr!, title: "最新版" } }));
  expect(screen.getByText("PR #128 最新版", { exact: true })).toBeVisible();
});

it("表示中の先行する手動取得が 502 でも、配信で取得した新しい成功を残す", async () => {
  let rejectRead!: (error: Error) => void;
  const pending = new Promise<PrResponse>((_, reject) => {
    rejectRead = reject;
  });
  const f = await fixture();
  f.api.get.mockReturnValueOnce(pending);
  await f.enter("GitHub から読み直す");
  f.set({ ...response, pr: { ...response.pr!, title: "配信の最新版" } });
  await f.issueChanged();
  await screen.findByText("PR #128 配信の最新版", { exact: true });

  await act(async () =>
    rejectRead(new ConversationApiError(502, "github_unavailable", "古い読み直しのエラー")),
  );

  expect(screen.getByText("PR #128 配信の最新版", { exact: true })).toBeVisible();
  expect(screen.queryByText("古い読み直しのエラー", { exact: true })).not.toBeInTheDocument();
});

it("取得不能の PR に保存済み応答が無いときは読み直す操作を出し、取得成功で表示を戻す", async () => {
  const f = await fixture();
  const message = "gh にログインしていません。ターミナルで gh auth login を実行してください";
  f.api.get.mockRejectedValueOnce(new ConversationApiError(502, "github_unavailable", message));
  await f.enter("GitHub から読み直す");
  await screen.findByText(message, { exact: true });
  expect(screen.queryByText("PR #128 予約カレンダーに祝日を表示する")).not.toBeInTheDocument();
  expect(screen.queryByText("merge を許可する")).not.toBeInTheDocument();

  await f.enter("GitHub から読み直す");
  await screen.findByText("PR #128 予約カレンダーに祝日を表示する", { exact: true });
});

it("同じ状態コードで取得が続けて失敗しても、新しい失敗の案内に更新する", async () => {
  const f = await fixture();
  f.api.get.mockRejectedValueOnce(
    new ConversationApiError(502, "github_unavailable", "最初の取得エラー"),
  );
  await f.enter("GitHub から読み直す");
  await screen.findByText("最初の取得エラー", { exact: true });
  f.api.get.mockRejectedValueOnce(
    new ConversationApiError(502, "github_unavailable", "二度目の取得エラー"),
  );
  await f.enter("GitHub から読み直す");
  await screen.findByText("二度目の取得エラー", { exact: true });
  expect(screen.queryByText("最初の取得エラー", { exact: true })).not.toBeInTheDocument();
});

it("同じ表示でネットワークが途切れたとき、最後の差分と失敗の案内を残す", async () => {
  const f = await fixture();
  f.api.get.mockRejectedValueOnce(new TypeError("回線に接続できません"));
  await f.enter("GitHub から読み直す");
  await screen.findByText(/回線に接続できません/);
  expect(screen.getByText("PR #128 予約カレンダーに祝日を表示する", { exact: true })).toBeVisible();
  f.set({ ...response, pr: { ...response.pr!, title: "通信が戻った後の差分" } });
  await f.enter("GitHub から読み直す");
  await screen.findByText("PR #128 通信が戻った後の差分", { exact: true });
  expect(screen.queryByText(/回線に接続できません/)).not.toBeInTheDocument();
});

it("表示中に待ちと実行中があるときだけ 30 秒で取得し、アンマウント時に止める", async () => {
  const f = await fixture({ ...response, checks: [check("test", "queued")] });
  const { advance } = f;
  await advance(29_999);
  expect(f.api.get).toHaveBeenCalledTimes(1);
  f.set({ ...response, checks: [check("test", "running")] });
  await advance(1);
  expect(f.api.get).toHaveBeenCalledTimes(2);
  f.set({ ...response, checks: [check("test", "success")] });
  await advance(30_000);
  expect(f.api.get).toHaveBeenCalledTimes(3);
  await advance(60_000);
  expect(f.api.get).toHaveBeenCalledTimes(3);

  f.set({ ...response, checks: [check("test", "running")] });
  await f.issueChanged();
  expect(f.api.get).toHaveBeenCalledTimes(4);
  f.mounted.unmount();
  await advance(60_000);
  expect(f.api.get).toHaveBeenCalledTimes(4);
});

it("画像が読み込めないときは URL の行を残す", async () => {
  const url = "https://evidence.example.test/reservation.png";
  await fixture({
    ...response,
    evidence: { markdown: `![予約一覧](${url})`, images: [{ alt: "予約一覧", url }] },
  });
  const image = await screen.findByRole("img", { name: "予約一覧" });
  fireEvent.error(image);
  expect(screen.queryByRole("img", { name: "予約一覧" })).not.toBeInTheDocument();
  expect(screen.getByText(url, { exact: true })).toBeVisible();
});

it.each([
  { name: "許可の成功", error: null, notice: "merge を許可しました", kind: "info" },
  {
    name: "許可の競合",
    error: "表示した後に変更が更新されました。読み直してから許可してください",
    kind: "error",
  },
])("$name を表示中の headSha を渡して知らせる", async ({ error, notice, kind }) => {
  const f = await fixture(response, [item("a")]);
  if (error)
    f.api.allowMerge.mockRejectedValueOnce(new ConversationApiError(409, "conflict", error));
  await f.enter("merge を許可する");
  expect(f.controller.snapshot().confirmation?.text).toBe(
    "merge を許可しますか? 送っていない指示が 1 件あります。許可しても送られずに残ります",
  );
  await f.press("y");
  expect(f.api.allowMerge).toHaveBeenCalledWith("i", sha);
  expect(f.notify).toHaveBeenCalledWith(error ?? notice, kind);
});

it("PR の差分行の Space c が実装会話のストックへ引用を付け、入力後に印が付く", async () => {
  const f = await fixture();
  f.cursor("fetchHolidays()");
  await f.press(" ", "c");
  await f.submit("祝日の色を直す");
  expect(f.stockApi.add).toHaveBeenCalledWith("c", {
    kind: "instruction",
    text: "祝日の色を直す",
    quote: {
      kind: "pr_diff",
      path: "src/calendar/holiday.ts",
      commit: sha,
      mode: "line",
      text: "const days = fetchHolidays()",
      start: { side: "old", line: 18, col: 0 },
      end: { side: "old", line: 18, col: 28 },
    },
  });
  expect(screen.getByText("!", { exact: true })).toBeVisible();
});

it.each([
  {
    mode: "Normal のカーソル",
    keys: [],
    ids: ["a"],
    notice: "指示 1 件を GitHub に投稿しました",
  },
  {
    mode: "Visual の行選択",
    keys: ["V", "j", "j"],
    ids: ["a", "b"],
    notice: "指示 1 件を GitHub に投稿しました。1 件を飛ばしました",
  },
])(
  "ストック一覧の $mode で Space s g と y を押すと、対象だけを投稿する",
  async ({ keys, ids, notice }) => {
    const f = await fixture(response, [item("a"), item("b", "instruction", "sent")]);
    await f.press(" ", "l");
    f.cursor("指示 a", "right");
    await f.press(...keys, " ", "s", "g");
    expect(screen.getByLabelText("操作の確認")).toHaveTextContent(
      `選んだ指示 ${ids.length} 件を、PR のレビューコメントとして GitHub に投稿しますか? (y / n)`,
    );
    await f.press("y");
    expect(f.api.publish).toHaveBeenCalledExactlyOnceWith("i", ids);
    expect(f.notify).toHaveBeenCalledWith(notice, "info");
    await waitFor(() => expect(screen.getByText(/指示 a.*GitHub に投稿済み/)).toBeVisible());
  },
);

it.each([
  { action: "そのまま", leaveVisual: false, mode: "VISUAL LINE" },
  { action: "先に Esc", leaveVisual: true, mode: "NORMAL" },
])(
  "GitHub 投稿を待つあいだに $action にすると、投稿済みの表示後もそのモードを保つ",
  async ({ leaveVisual, mode }) => {
    const f = await fixture(response, [item("a"), item("b", "instruction", "sent")]);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const publish = f.api.publish.getMockImplementation()!;
    f.api.publish.mockImplementationOnce(async (...input) => {
      await pending;
      return publish(...input);
    });
    await f.press(" ", "l");
    f.cursor("指示 a", "right");
    await f.press("V", "j", "j", " ", "s", "g", "y");
    expect(f.api.publish).toHaveBeenCalledExactlyOnceWith("i", ["a", "b"]);
    expect(f.controller.snapshot().mode).toBe("VISUAL LINE");
    if (leaveVisual) await f.press("Escape");
    await act(async () => finish());

    await screen.findByText(/指示 a.*GitHub に投稿済み/);
    expect(f.controller.snapshot().mode).toBe(mode);
    if (!leaveVisual) {
      await f.press(" ", "s", "g");
      expect(screen.getByLabelText("操作の確認")).toHaveTextContent("選んだ指示 2 件");
    }
  },
);

it("Visual の GitHub 投稿を n でやめても、その範囲をもう一度選び直さず確認できる", async () => {
  const f = await fixture(response, [item("a"), item("b")]);
  await f.press(" ", "l");
  f.cursor("指示 a", "right");
  await f.press("V", "j", "j", " ", "s", "g");
  expect(screen.getByLabelText("操作の確認")).toHaveTextContent("選んだ指示 2 件");
  await f.press("n");
  expect(f.api.publish).not.toHaveBeenCalled();
  expect(f.controller.snapshot().mode).toBe("VISUAL LINE");
  await f.press(" ", "s", "g");
  expect(screen.getByLabelText("操作の確認")).toHaveTextContent("選んだ指示 2 件");
});

it.each([
  { event: "選択より前の削除", removed: "before", mode: "VISUAL LINE" },
  { event: "選択末尾の削除", removed: "b", mode: "NORMAL" },
  { event: "選択の途中への挿入", removed: null, mode: "NORMAL" },
])("$event で一覧を更新しても、同じ本文の別指示を投稿選択に加えない", async ({ removed, mode }) => {
  const items = [item("before"), item("a"), item("b"), item("c")];
  const f = await fixture(response, items);
  await f.press(" ", "l");
  f.cursor("指示 a", "right");
  await f.press("V");
  const editor = EditorView.findFromDOM(document.activeElement!.closest(".cm-editor")!)!;
  const rows = f.controller.windowLines("right");
  const start = rows.findIndex(({ id }) => id === "a");
  const end = rows.findIndex(({ id }) => id === "b") + 1;
  expect(rows[end].text).toContain("> 位置");
  act(() =>
    editor.dispatch({
      selection: {
        anchor: editor.state.doc.line(start + 1).from,
        head: editor.state.doc.line(end + 1).to,
      },
    }),
  );
  await f.press(" ", "s", "g");
  expect(screen.getByLabelText("操作の確認")).toHaveTextContent("選んだ指示 2 件");
  await f.press("n");

  f.setStock(
    removed === null
      ? [...items.slice(0, 2), item("inserted"), ...items.slice(2)]
      : items.filter(({ id }) => id !== removed),
  );
  await f.reloadStock();
  if (removed === null) await screen.findByText(/指示 inserted/);
  else
    await waitFor(() =>
      expect(screen.queryByText(new RegExp(`指示 ${removed}(?:\\s|$)`))).not.toBeInTheDocument(),
    );
  expect(f.controller.snapshot().mode).toBe(mode);
  if (mode === "VISUAL LINE") {
    await f.press(" ", "s", "g");
    expect(screen.getByLabelText("操作の確認")).toHaveTextContent("選んだ指示 2 件");
    await f.press("y");
    expect(f.api.publish).toHaveBeenCalledExactlyOnceWith("i", ["a", "b"]);
  } else expect(f.api.publish).not.toHaveBeenCalled();
});

it("未送信のストックがなくても、実装に戻すレビューの見出しへ 0 件を出して本文を送る", async () => {
  const f = await fixture();
  await f.enter("指摘を書いて実装に戻す");
  expect(screen.getByText("会話: #12 の実装 (ストックの指示 0 件と一緒に送る)")).toBeVisible();
  await f.submit("本文だけ修正");
  expect(f.sent).toHaveBeenCalledExactlyOnceWith("c", {
    clientMessageId: "message-id",
    images: [],
    mode: "send",
    text: "本文だけ修正",
  });
});

it("レビュー入力を閉じた案内から、同じ書きかけを開き直せる", async () => {
  const f = await fixture();
  await f.enter("指摘を書いて実装に戻す");
  const input = screen.getByRole("textbox", { name: /^指示$/ });
  const editor = EditorView.findFromDOM(input.closest(".cm-editor")!)!;
  act(() => editor.dispatch({ changes: { from: 0, insert: "あとで続ける" } }));
  await f.press("Escape", "Escape");
  expect(f.notify).toHaveBeenCalledWith(
    "書きかけを残しました。「指摘を書いて実装に戻す」で続きを書けます",
    "info",
  );
  await f.enter("指摘を書いて実装に戻す");
  expect(screen.getByRole("textbox", { name: /^指示$/ })).toHaveTextContent("あとで続ける");
});

it("PR が閉じても送信済みの行に矢印と投稿済みを表示し、投稿操作は登録しない", async () => {
  const sent = {
    ...item("b", "instruction", "sent"),
    githubCommentUrl: "https://github.com/test/review",
  };
  const f = await fixture(response, [sent]);
  await f.press(" ", "l");
  await screen.findByText(/→.*指示 b.*GitHub に投稿済み/);
  f.set({ ...response, pr: { ...response.pr!, state: "closed" } });
  await f.issueChanged();
  await screen.findByText(/→.*指示 b.*GitHub に投稿済み/);
  f.cursor("指示 b", "right");
  await f.press(" ", "s", "g");
  expect(screen.queryByLabelText("操作の確認")).not.toBeInTheDocument();
});

const changedDraft = {
  topic: "conversation:c",
  seq: 1,
  type: "changed",
  payload: { parts: ["draft"] },
};
const remoteDraft = (text: string): Snapshot => ({
  ...snapshot,
  draft: { text, images: [], updatedAt: 100, updatedBy: "another-tab" },
});

it.each([
  { mode: "レビューだけ", ordinary: false },
  { mode: "同じセッションの会話購読もある", ordinary: true },
])(
  "$mode ときも、別タブの下書きを一度だけ読み直し入力とお知らせに反映する",
  async ({ ordinary }) => {
    const f = await fixture(response, [], true);
    await act(async () => f.sockets[0].onopen?.());
    await f.enter("指摘を書いて実装に戻す");
    if (ordinary) {
      await act(async () => {
        const unsubscribe = f.subscribeConversation();
        if (unsubscribe) disposals.push(unsubscribe);
      });
    }
    f.getConversation.mockResolvedValueOnce(remoteDraft("別のタブから保存した指摘"));
    await act(async () => f.sockets[0].onmessage?.({ data: JSON.stringify(changedDraft) }));

    expect(f.getConversation).toHaveBeenCalledExactlyOnceWith("c");
    expect(screen.getByRole("textbox", { name: /^指示$/ })).toHaveTextContent(
      "別のタブから保存した指摘",
    );
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(
      "別の端末で書いた内容に置き換わりました",
      "info",
    );
  },
);

it.each([
  { view: "レビューだけ", ordinary: false },
  { view: "同じ会話を購読中", ordinary: true },
])("$view の読み込み中に届いた下書きを、重ねてGETせず開いた入力に使う", async ({ ordinary }) => {
  const f = await fixture(response, [], true, false, { loadFromWorkspace: true });
  await act(async () => f.sockets[0].onopen?.());
  const observed = vi.fn();
  const probe = f.subscribeProbe?.("conversation:c", observed);
  if (probe) disposals.push(probe);
  if (ordinary) {
    const session = await f.loadConversation?.("c");
    if (!session) throw new Error("実装の会話を読み込めませんでした");
    await act(async () => {
      const unsubscribe = f.subscribeSession?.(session);
      if (unsubscribe) disposals.push(unsubscribe);
    });
    f.getConversation.mockClear();
    f.getEvents.mockClear();
  }
  let finishEvents!: () => void;
  f.getEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishEvents = () => resolve({ events: [], lastSeq: 0, hasMore: false });
      }),
  );
  await f.enter("指摘を書いて実装に戻す");
  expect(f.getConversation).toHaveBeenCalledExactlyOnceWith("c");
  expect(f.getEvents).toHaveBeenCalledExactlyOnceWith("c", 0);
  expect(screen.queryByRole("textbox", { name: /^指示$/ })).not.toBeInTheDocument();

  f.getConversation.mockResolvedValueOnce(remoteDraft("読み込み中に別のタブで保存した指摘"));
  await act(async () => f.sockets[0].onmessage?.({ data: JSON.stringify(changedDraft) }));
  expect(observed).toHaveBeenCalledExactlyOnceWith(changedDraft);
  await act(async () => finishEvents());

  expect(f.getConversation).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("textbox", { name: /^指示$/ })).toHaveTextContent(
    "読み込み中に別のタブで保存した指摘",
  );
});

it.each([
  { order: "初回の読み取りが先", latestFirst: false },
  { order: "更新後の読み取りが先", latestFirst: true },
])("$order に返っても、初回の読み取り中に保存された新しい下書きで開く", async ({ latestFirst }) => {
  const f = await fixture(response, [], true, false, { loadFromWorkspace: true });
  await act(async () => f.sockets[0].onopen?.());
  let resolveInitial!: (snapshot: Snapshot) => void;
  let resolveLatest!: (snapshot: Snapshot) => void;
  const initial = new Promise<Snapshot>((resolve) => {
    resolveInitial = resolve;
  });
  const latest = new Promise<Snapshot>((resolve) => {
    resolveLatest = resolve;
  });
  f.getConversation.mockReturnValueOnce(initial).mockReturnValueOnce(latest);
  await f.enter("指摘を書いて実装に戻す");
  expect(f.getConversation).toHaveBeenCalledExactlyOnceWith("c");
  await act(async () => f.sockets[0].onmessage?.({ data: JSON.stringify(changedDraft) }));
  expect(f.getConversation.mock.calls).toEqual([["c"], ["c"]]);

  if (latestFirst) await act(async () => resolveLatest(remoteDraft("配信を受けた新しい下書き")));
  else await act(async () => resolveInitial(snapshot));
  expect(screen.queryByRole("textbox", { name: /^指示$/ })).not.toBeInTheDocument();

  if (latestFirst) await act(async () => resolveInitial(snapshot));
  else await act(async () => resolveLatest(remoteDraft("配信を受けた新しい下書き")));

  expect(screen.getByRole("textbox", { name: /^指示$/ })).toHaveTextContent(
    "配信を受けた新しい下書き",
  );
});

it("レビューを初めて開くと、同じタブで保存した本文も復元される", async () => {
  const f = await fixture(response, [], true, false, { loadFromWorkspace: true });
  f.getConversation.mockResolvedValueOnce({
    ...snapshot,
    draft: { text: "このタブで保存した指摘", images: [], updatedAt: 100, updatedBy: "tab" },
  });
  await f.enter("指摘を書いて実装に戻す");
  expect(screen.getByRole("textbox", { name: /^指示$/ })).toHaveTextContent(
    "このタブで保存した指摘",
  );
  expect(f.notify).not.toHaveBeenCalledWith("別の端末で書いた内容に置き換わりました", "info");
});

it("PR 入力を開く前に画面を移った場合、遅れて届く取得失敗で次の画面に通知を出さない", async () => {
  const f = await fixture(response, [], true, false, { loadFromWorkspace: true });
  let rejectEvents!: (error: Error) => void;
  f.getEvents.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectEvents = reject;
      }),
  );
  await f.enter("指摘を書いて実装に戻す");
  act(() => f.controller.changeScreen("/issues/別のissue/会話"));
  await act(async () => rejectEvents(new Error("前の画面の読み込みが失敗")));
  expect(f.controller.snapshot().prompt).toBeNull();
  expect(f.notify).not.toHaveBeenCalledWith("前の画面の読み込みが失敗", "error");
});

it("配信が切れている間に他のタブで保存した下書きを、再接続時に一度読み直す", async () => {
  const f = await fixture(response, [], true);
  await act(async () => f.sockets[0].onopen?.());
  await f.enter("指摘を書いて実装に戻す");
  await act(async () => f.sockets[0].onclose?.());
  await f.advance(500);
  f.getConversation.mockResolvedValueOnce(remoteDraft("接続がない間に保存した指摘"));
  await act(async () => f.sockets[1].onopen?.());
  expect(f.getConversation).toHaveBeenCalledExactlyOnceWith("c");
  expect(screen.getByRole("textbox", { name: /^指示$/ })).toHaveTextContent(
    "接続がない間に保存した指摘",
  );
});

it("別タブから下書きが届いても、自分の未保存の指摘を保って知らせる", async () => {
  const f = await fixture(response, [], true);
  await act(async () => f.sockets[0].onopen?.());
  await f.enter("指摘を書いて実装に戻す");
  const input = screen.getByRole("textbox", { name: /^指示$/ });
  const editor = EditorView.findFromDOM(input.closest(".cm-editor")!)!;
  act(() => editor.dispatch({ changes: { from: 0, insert: "自分の未保存の指摘" } }));
  f.getConversation.mockResolvedValueOnce(remoteDraft("別端末で保存した指摘"));
  await act(async () => f.sockets[0].onmessage?.({ data: JSON.stringify(changedDraft) }));
  expect(input).toHaveTextContent("自分の未保存の指摘");
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("別の端末で書き換えられました", "info");
});

it("閉じた PR 入力への古い下書きの応答は、開き直した入力やフォーカスを変えない", async () => {
  const f = await fixture(response, [], true);
  await act(async () => f.sockets[0].onopen?.());
  await f.enter("指摘を書いて実装に戻す");
  let resolve!: (snapshot: Snapshot) => void;
  const pending = new Promise<Snapshot>((done) => {
    resolve = done;
  });
  f.getConversation.mockReturnValueOnce(pending);
  await act(async () => f.sockets[0].onmessage?.({ data: JSON.stringify(changedDraft) }));
  expect(f.getConversation).toHaveBeenCalledTimes(1);

  await f.press("Escape", "Escape");
  await act(async () => f.sockets[0].onmessage?.({ data: JSON.stringify(changedDraft) }));
  expect(f.getConversation).toHaveBeenCalledTimes(1);
  await f.enter("指摘を書いて実装に戻す");
  await act(async () => resolve(remoteDraft("閉じた入力への古い応答")));

  const input = screen.getByRole("textbox", { name: /^指示$/ });
  expect(input).toHaveFocus();
  expect(input).not.toHaveTextContent("閉じた入力への古い応答");
  expect(f.notify).not.toHaveBeenCalledWith("別の端末で書いた内容に置き換わりました", "info");
});

it("PR の入力を接続断中に閉じると、再接続で書きかけを保存し、会話は既読にしない", async () => {
  const f = await fixture(response, [], true);
  await act(async () => {
    f.sockets[0].onopen?.();
    f.sockets[0].onclose?.();
  });
  await f.advance(3_000);
  await f.enter("指摘を書いて実装に戻す");
  const input = screen.getByRole("textbox", { name: /^指示$/ });
  const editor = EditorView.findFromDOM(input.closest(".cm-editor")!)!;
  act(() => editor.dispatch({ changes: { from: 0, insert: "オフラインの指摘" } }));
  await f.press("Escape", "Escape");
  expect(f.saveDraft).not.toHaveBeenCalled();

  await act(async () => f.sockets[1].onopen?.());
  expect(f.saveDraft).toHaveBeenCalledExactlyOnceWith(
    "c",
    expect.objectContaining({ text: "オフラインの指摘" }),
  );
  expect(f.sockets[1].sent).not.toContainEqual({ op: "shown", topics: ["conversation:c"] });
});

it("複数ファイルの選択は引用の入力欄を開かず、ファイルごとに選ぶ案内を出す", async () => {
  const f = await fixture({ ...response, files: [file, { ...file, path: "calendar-alt.ts" }] });
  const lines = f.controller.windowLines("main");
  const from = lines.findIndex((line) => line.kind === "del");
  const to = lines.findLastIndex((line) => line.kind === "del");
  await act(async () =>
    f.controller.run("stock.instruct", {
      ...f.controller.context("main"),
      selection: {
        mode: "line",
        ranges: [from, to].map((line) => ({ line, from: 0, to: lines[line].text.length })),
      },
    }),
  );
  expect(f.controller.snapshot().prompt).toBeNull();
  expect(f.notify).toHaveBeenCalledWith(
    "ファイルごとに範囲を選んでから指摘を書いてください",
    "error",
  );
});

it("まだ届いていない指示の矢印を開くと、同じ会話のそのストック ID へ移る", async () => {
  const queued: StockItem = {
    ...item("queued", "instruction", "sent"),
    sentSeq: null,
    quote: {
      kind: "pr_diff",
      mode: "line",
      path: file.path,
      commit: sha,
      text: "const days = fetchHolidays()",
      start: { line: 18, col: 0, side: "old" },
      end: { line: 18, col: 28, side: "old" },
    },
  };
  const f = await fixture(response, [queued]);
  const navigate = vi.fn();
  f.controller.options.navigate = navigate;
  await f.enter("fetchHolidays()");
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/conversations/c?stock=queued");
});

it("ストック ID の会話リンクは、待ち行列の末尾からではなく該当する指示の行を開く", async () => {
  const controller = new BufferController({ url: "/conversations/c?stock=queued" });
  const queue = [
    { id: "selected", text: "選んだ指示", position: 1, stockItemId: "queued" },
    { id: "last", text: "一番新しい指示", position: 2, stockItemId: null },
  ].map((item) => ({ ...item, images: [], clientId: null, createdAt: 0 }));
  const api = {
    ...createConversationApi(async () => {
      throw new Error("予期しない会話 API");
    }),
    get: async () => ({ ...snapshot, queue }),
    events: async () => ({ events: [], lastSeq: 0, hasMore: false }),
  };
  const conversations = createConversationWorkspace(
    api,
    controller,
    { clientId: "tab", id: () => "id", now: () => 0, schedule: () => () => {} },
    () => {
      throw new Error("WebSocket は起動しません");
    },
  );
  const loaded = await conversations.loadScreen({
    kind: "conversation",
    id: "c",
    query: "stock=queued",
  });
  if (loaded?.kind !== "ready") throw new Error("会話を開けませんでした。");
  await act(async () => render(<Layout controller={controller} main={loaded.content} />));
  expect(controller.currentLine("main")?.text).toContain("選んだ指示");
});

it("実装に戻す入力欄に対象件数を出し、Enter で本文と未送信指示だけを一度に送る", async () => {
  const f = await fixture(response, [
    item("a"),
    item("b", "question"),
    item("c", "instruction", "sent"),
  ]);
  await f.enter("指摘を書いて実装に戻す");
  expect(screen.getByText("会話: #12 の実装 (ストックの指示 1 件と一緒に送る)")).toBeVisible();
  await f.submit("追加の指摘");
  expect(f.sent).toHaveBeenCalledExactlyOnceWith("c", {
    clientMessageId: "message-id",
    images: [],
    mode: "send",
    stockIds: ["a"],
    text: "追加の指摘",
  });
});
