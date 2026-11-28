import { expect, it, vi } from "vite-plus/test";
import { createBrowserNotifications } from "./notifications";
import { InboxApiError, InboxStore, createInboxApi } from "./inbox-store";
import { createNotices } from "../shell/notices";
import type { InboxResponse, InboxRow } from "../../shared/inbox/schema";

function row(section: InboxRow["section"], unread: boolean): InboxRow {
  return {
    key: "conversation:c",
    kind: "conversation",
    id: "c",
    project: { id: "p", name: "project-p" },
    title: "会話: c",
    section,
    reason: "turn_ended",
    status: "",
    notice: "",
    unread,
    priority: null,
    lastActivityAt: 0,
    threadAnswers: 0,
    activity: null,
    issue: null,
  };
}
function data(rows: InboxRow[]): InboxResponse {
  return {
    sections: (["decision", "instruction", "working"] as const).map((name) => ({
      name,
      rows: rows.filter((r) => r.section === name),
    })),
  };
}
function timers() {
  return {
    schedule(callback: () => void, ms: number) {
      const timeout = setTimeout(callback, ms);
      return () => clearTimeout(timeout);
    },
  };
}

function fixture({
  inbox,
  title = () => {},
  notify = () => {},
}: {
  inbox: () => Promise<InboxResponse>;
  title?: (value: string) => void;
  notify?: ReturnType<typeof createNotices>["notify"];
}) {
  const app = createBrowserNotifications({ notify, title });
  const storage = new Map<string, string>();
  const store = new InboxStore(
    {
      inbox,
      projects: async () => ({ projects: [] }),
      overview: async () => {
        throw new Error("このテストではプロジェクトを開かない");
      },
    },
    {
      ...timers(),
      now: () => Date.now(),
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
      },
    },
    app.updateTitle,
  );
  return {
    reload: store.reload,
    receive: (message: Parameters<typeof app.receive>[0]) => {
      app.receive(message);
      store.receive(message);
    },
    dispose: () => store.dispose(),
    store,
  };
}

it("通知付きnoticeを既存のお知らせとして4秒表示する", () => {
  vi.useFakeTimers();
  const timer = timers();
  const notices = createNotices(timer);
  const app = fixture({
    inbox: async () => data([]),
    notify: notices.notify,
    title: () => {},
  });
  try {
    app.receive({
      topic: "app",
      seq: 1,
      type: "notice",
      payload: {
        level: "info",
        message: "c (project-p): どちらですか",
        notification: { tag: "conversation:c", url: "/conversations/c" },
      },
    });
    expect(notices.snapshot()).toEqual({ error: null, info: "c (project-p): どちらですか" });
    vi.advanceTimersByTime(4000);
    expect(notices.snapshot()).toEqual({ error: null, info: null });
  } finally {
    app.dispose();
    notices.dispose();
    vi.useRealTimers();
  }
});

it("通知用メタデータが無い issue の反映失敗もエラーのお知らせに出す", () => {
  const notify = vi.fn();
  const app = createBrowserNotifications({ notify, title: () => {} });
  app.receive({
    topic: "app",
    seq: 1,
    type: "notice",
    payload: { level: "info", message: "読み込みました", issue_id: "issue" },
  });
  app.receive({
    topic: "app",
    seq: 2,
    type: "notice",
    payload: {
      level: "error",
      message: "既定ブランチと設計書の変更がぶつかりました",
      issue_id: "issue",
    },
  });
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "既定ブランチと設計書の変更がぶつかりました",
    "error",
  );
});

it("未読の判断待ちと指示待ちだけをタイトルに数え、更新を1秒にまとめる", async () => {
  vi.useFakeTimers();
  let inbox = data([
    row("decision", true),
    row("instruction", true),
    row("instruction", false),
    row("working", true),
  ]);
  const titles: string[] = [];
  let reads = 0;
  const app = fixture({
    inbox: async () => {
      reads++;
      return inbox;
    },
    notify: () => {},
    title: (title) => titles.push(title),
  });
  try {
    await app.reload();
    expect({ reads, titles }).toEqual({ reads: 1, titles: ["(2) sukuna"] });
    inbox = data([row("decision", false)]);
    app.receive({ topic: "inbox", seq: 1, type: "changed", payload: {} });
    app.receive({ topic: "inbox", seq: 2, type: "changed", payload: {} });
    await vi.advanceTimersByTimeAsync(999);
    expect({ reads, titles }).toEqual({ reads: 1, titles: ["(2) sukuna"] });
    await vi.advanceTimersByTimeAsync(1);
    expect({ reads, titles }).toEqual({ reads: 2, titles: ["(2) sukuna", "sukuna"] });
  } finally {
    app.dispose();
    vi.useRealTimers();
  }
});

it.each(["reload", "changed"] as const)(
  "%s の一時503後に次の変化がなくても件数が回復する",
  async (request) => {
    vi.useFakeTimers();
    const titles: string[] = [];
    let reads = 0;
    const app = fixture({
      inbox: createInboxApi(async () => {
        if (++reads === 1) return new Response("一時停止", { status: 503 });
        return Response.json(data([row("decision", true)]));
      }).inbox,
      notify: () => {},
      title: (title) => titles.push(title),
    });
    try {
      const triggerDelay = request === "changed" ? 1000 : 0;
      if (request === "reload") void app.reload();
      else app.receive({ topic: "inbox", seq: 1, type: "changed", payload: {} });
      await vi.advanceTimersByTimeAsync(triggerDelay);
      await vi.advanceTimersByTimeAsync(999);
      expect({ reads, titles }).toEqual({ reads: 1, titles: [] });
      await vi.advanceTimersByTimeAsync(1);
      expect({ reads, titles }).toEqual({ reads: 2, titles: ["(1) sukuna"] });
    } finally {
      app.dispose();
      vi.useRealTimers();
    }
  },
);

it.each([
  { status: 503, attempts: 3 },
  { status: 401, attempts: 1 },
] as const)(
  "$status の取得失敗を繰り返し続けず、次の通常更新は取得する",
  async ({ status, attempts }) => {
    vi.useFakeTimers();
    let reads = 0;
    let intermittent = true;
    const titles: string[] = [];
    const app = fixture({
      inbox: async () => {
        reads++;
        if (intermittent) throw new InboxApiError("failure", "取得失敗", status);
        return data([row("decision", true)]);
      },
      notify: () => {},
      title: (title) => titles.push(title),
    });
    try {
      await app.reload();
      await vi.advanceTimersByTimeAsync(7000);
      expect({ reads, titles }).toEqual({ reads: attempts, titles: [] });
      intermittent = false;
      await app.reload();
      expect({ reads, titles }).toEqual({ reads: attempts + 1, titles: ["(1) sukuna"] });
    } finally {
      app.dispose();
      vi.useRealTimers();
    }
  },
);

it("破棄すると予約した再試行を止める", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const app = fixture({
    inbox: async () => {
      reads++;
      throw new InboxApiError("runner_unavailable", "一時停止", 503);
    },
    notify: () => {},
    title: () => {},
  });
  try {
    await app.reload();
    app.dispose();
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toBe(1);
  } finally {
    app.dispose();
    vi.useRealTimers();
  }
});

it("背景の未読件数と表示中の一覧が同じGETを使い、画面を離れても件数を更新する", async () => {
  vi.useFakeTimers();
  const titles: string[] = [];
  let rows = data([row("decision", true)]);
  const inbox = vi.fn(async () => rows);
  const app = fixture({ inbox, title: (title) => titles.push(title) });
  try {
    const unsubscribe = app.store.inbox.subscribe(() => {});
    await app.store.inbox.load();
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(app.store.inbox.snapshot().data).toEqual(rows);
    expect(titles).toEqual(["(1) sukuna"]);

    rows = data([row("decision", true), row("instruction", true)]);
    app.receive({ topic: "inbox", seq: 1, type: "changed", payload: {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(app.store.inbox.snapshot().data).toEqual(rows);
    expect(titles).toEqual(["(1) sukuna", "(2) sukuna"]);
    unsubscribe();

    rows = data([]);
    app.receive({ topic: "inbox", seq: 2, type: "changed", payload: {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(inbox).toHaveBeenCalledTimes(3);
    expect(titles.at(-1)).toBe("sukuna");

    rows = data([row("instruction", true)]);
    const unsubscribeAgain = app.store.inbox.subscribe(() => {});
    await app.store.inbox.load();
    expect(inbox).toHaveBeenCalledTimes(4);
    expect(app.store.inbox.snapshot().data).toEqual(rows);
    expect(titles.at(-1)).toBe("(1) sukuna");
    unsubscribeAgain();
  } finally {
    app.dispose();
    vi.useRealTimers();
  }
});

it("接続前の取得を待ったあとの読み直しも、一時503から回復する", async () => {
  vi.useFakeTimers();
  const titles: string[] = [];
  let finishFirst: (value: InboxResponse) => void = () => {};
  const first = new Promise<InboxResponse>((resolve) => {
    finishFirst = resolve;
  });
  const inbox = vi
    .fn(async () => data([row("decision", true)]))
    .mockReturnValueOnce(first)
    .mockRejectedValueOnce(new InboxApiError("runner_unavailable", "一時停止", 503));
  const app = fixture({ inbox, title: (value) => titles.push(value) });
  try {
    const unsubscribe = app.store.inbox.subscribe(() => {});
    const reloading = app.reload();
    finishFirst(data([]));
    await reloading;
    expect(inbox).toHaveBeenCalledTimes(2);
    expect(titles).toEqual(["sukuna"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(inbox).toHaveBeenCalledTimes(3);
    expect(titles).toEqual(["sukuna", "(1) sukuna"]);
    unsubscribe();
  } finally {
    app.dispose();
    vi.useRealTimers();
  }
});
