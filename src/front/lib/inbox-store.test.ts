import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import {
  inboxResponseSchema,
  projectsResponseSchema,
  overviewResponseSchema,
  type InboxResponse,
  type ProjectsResponse,
  type OverviewResponse,
} from "../../shared/inbox/schema";
import { InboxStore, createInboxApi, type InboxApi } from "./inbox-store";
import { response, row } from "./inbox.test-support";

const empty: InboxResponse = {
  sections: [
    { name: "decision", rows: [] },
    { name: "instruction", rows: [] },
    { name: "working", rows: [] },
  ],
};
const projects: ProjectsResponse = { projects: [] };
const overview: OverviewResponse = {
  project: { id: "p", name: "project-p", flowPaused: false },
  issueSections: [],
  conversations: [],
};
function fixture() {
  vi.useFakeTimers();
  const api = {
    inbox: vi.fn(async () => empty),
    projects: vi.fn(async () => projects),
    overview: vi.fn(async () => overview),
  } satisfies InboxApi;
  const store = new InboxStore(api, {
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    storage: new MapStorage(),
  });
  return { api, store };
}
class MapStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
afterEach(() => vi.useRealTimers());

type ResourceKind = "inbox" | "projects" | "overview";
const resourceKinds: ResourceKind[] = ["inbox", "projects", "overview"];
function listingData(version: number) {
  return {
    inbox: inboxResponseSchema.parse(response(row({ title: `会話: 予約-${version}` }))),
    projects: projectsResponseSchema.parse({
      projects: [
        { id: "p", name: `project-${version}`, flowPaused: false, conversations: [], issues: [] },
      ],
    }),
    overview: overviewResponseSchema.parse({
      ...overview,
      project: { ...overview.project, name: `project-${version}` },
    }),
  };
}
function delayedFixture(kind: ResourceKind, delayedRequest = 1) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let version = 0;
  const starts: number[] = [];
  const gate: { resolve?: () => void; reject?: (error: Error) => void } = {};
  const pending = new Promise<void>((resolve, reject) => {
    gate.resolve = resolve;
    gate.reject = reject;
  });
  const get = async <T>(resourceKind: ResourceKind, data: T) => {
    if (resourceKind !== kind) return data;
    starts.push(Date.now());
    if (starts.length === delayedRequest) await pending;
    return data;
  };
  const api: InboxApi = {
    inbox: () => get("inbox", listingData(version).inbox),
    projects: () => get("projects", listingData(version).projects),
    overview: () => get("overview", listingData(version).overview),
  };
  const store = new InboxStore(api, {
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    storage: new MapStorage(),
  });
  const resource = kind === "overview" ? store.overview("p") : store[kind];
  return {
    store,
    resource,
    starts,
    gate,
    version: (value: number) => {
      version = value;
    },
  };
}

it.each(resourceKinds)("%s は再接続と対象の配信で読み直す", async (kind) => {
  const f = delayedFixture(kind, 0);
  const stop = f.resource.subscribe(() => {});
  try {
    await f.resource.load();
    expect(f.resource.snapshot().data).toEqual(listingData(0)[kind]);
    f.version(1);
    await f.store.reload();
    expect(f.resource.snapshot()).toEqual({
      data: listingData(1)[kind],
      error: null,
      loading: false,
      now: 0,
    });
    f.version(2);
    f.store.receive({ topic: "inbox", seq: 0, type: "changed", payload: { project_ids: ["p"] } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.resource.snapshot()).toEqual({
      data: listingData(2)[kind],
      error: null,
      loading: false,
      now: 1000,
    });
    expect(f.starts).toEqual([0, 0, 1000]);
  } finally {
    stop();
    f.store.dispose();
  }
});

describe("一覧の先行取得と再接続・再表示", () => {
  const kind = "inbox";
  it.each(["reload", "reopen"] as const)(
    "先行GETが完了した後の%sでも最新を取得する",
    async (trigger) => {
      const f = delayedFixture(kind);
      const stop = f.resource.subscribe(() => {});
      f.gate.resolve?.();
      await f.resource.load();
      expect(f.resource.snapshot().data).toEqual(listingData(0)[kind]);
      f.version(1);
      let stopAgain: (() => void) | undefined;
      if (trigger === "reload") await f.store.reload();
      else {
        stop();
        stopAgain = f.resource.subscribe(() => {});
        await f.resource.load();
      }
      expect(f.resource.snapshot()).toEqual({
        data: listingData(1)[kind],
        error: null,
        loading: false,
        now: 0,
      });
      expect(f.starts).toEqual([0, 0]);
      stopAgain?.();
      stop();
    },
  );
  it.each([
    ["reload", false],
    ["reload", true],
    ["reopen", false],
    ["reopen", true],
  ] as const)(
    "%s時に先行GETが失敗=%sでも、その後の新しい一覧を取得する",
    async (trigger, failed) => {
      const f = delayedFixture(kind);
      const stop = f.resource.subscribe(() => {});
      f.version(1);
      const renewed = trigger === "reload" ? f.store.reload() : undefined;
      if (trigger === "reopen") stop();
      const stopAgain = trigger === "reopen" ? f.resource.subscribe(() => {}) : undefined;
      if (failed) f.gate.reject?.(new Error("切断前のGETが失敗しました"));
      else f.gate.resolve?.();
      await (renewed ?? f.resource.load());
      expect(f.resource.snapshot()).toEqual({
        data: listingData(1)[kind],
        error: null,
        loading: false,
        now: 0,
      });
      expect(f.starts).toEqual([0, 0]);
      stopAgain?.();
      stop();
      f.store.dispose();
    },
  );

  it("同じ画面の同時購読は最初のGETを共有する", async () => {
    const f = delayedFixture(kind);
    const stop = f.resource.subscribe(() => {});
    const stopSecond = f.resource.subscribe(() => {});
    f.gate.resolve?.();
    await f.resource.load();
    expect(f.resource.snapshot().data).toEqual(listingData(0)[kind]);
    expect(f.starts).toEqual([0]);
    stop();
    stopSecond();
  });

  it("再接続を待つ間に画面を離れたら読み直さず、次の再表示で最新を取得する", async () => {
    const f = delayedFixture(kind);
    const stop = f.resource.subscribe(() => {});
    f.version(1);
    const renewed = f.store.reload();
    stop();
    f.gate.resolve?.();
    await renewed;
    expect(f.starts).toEqual([0]);
    const stopAgain = f.resource.subscribe(() => {});
    await f.resource.load();
    expect(f.resource.snapshot().data).toEqual(listingData(1)[kind]);
    expect(f.starts).toEqual([0, 0]);
    stopAgain();
  });
});

describe("一覧のchangedの間隔", () => {
  const kind = "inbox";
  it.each(["fast", "slow", "failure"] as const)(
    "GETが%sでも開始間隔を1秒以上に保ち、最後の変更を反映する",
    async (speed) => {
      const f = delayedFixture(kind, speed === "fast" ? 0 : 2);
      const stop = f.resource.subscribe(() => {});
      await f.resource.load();
      const changed = (version: number) => {
        f.version(version);
        f.store.receive({
          topic: "inbox",
          seq: 0,
          type: "changed",
          payload: { project_ids: ["p"] },
        });
      };
      changed(1);
      await vi.advanceTimersByTimeAsync(1100);
      changed(2);
      await vi.advanceTimersByTimeAsync(1100);
      changed(3);
      await vi.advanceTimersByTimeAsync(900);
      if (speed === "failure") f.gate.reject?.(new Error("遅いGETが失敗しました"));
      else f.gate.resolve?.();
      await vi.advanceTimersByTimeAsync(100);
      for (let index = 1; index < f.starts.length; index++)
        expect(f.starts[index] - f.starts[index - 1]).toBeGreaterThanOrEqual(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.resource.snapshot()).toEqual({
        data: listingData(3)[kind],
        error: null,
        loading: false,
        now: f.starts.at(-1),
      });
      expect(f.starts).toEqual(speed === "fast" ? [0, 1000, 2100, 3200] : [0, 1000, 3100]);
      stop();
      f.store.dispose();
    },
  );
});

describe("一覧の読み直し", () => {
  it("読み直しの途中で完了を展開しても、そのあと全件を取得する", async () => {
    const { api, store } = fixture();
    const stop = store.overview("p").subscribe(() => {});
    await store.overview("p").load();
    const resolvers: ((value: OverviewResponse) => void)[] = [];
    const pending = new Promise<OverviewResponse>((resolve) => resolvers.push(resolve));
    api.overview.mockImplementationOnce(() => pending);
    const refreshing = store.reload();
    const expanded = store.expandClosed("p");
    resolvers[0](overview);
    await refreshing;
    await expanded;
    expect(api.overview.mock.calls).toEqual([
      ["p", false],
      ["p", false],
      ["p", true],
    ]);
    stop();
  });

  it("配信が途切れていても30秒ごとに経過を計算し直す時計が進み、閉じると止まる", async () => {
    const { store } = fixture();
    const stop = store.inbox.subscribe(() => {});
    await store.reload();
    const initial = store.inbox.snapshot().now;
    await vi.advanceTimersByTimeAsync(30000);
    expect(store.inbox.snapshot().now).toBe(initial + 30000);
    stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(store.inbox.snapshot().now).toBe(initial + 30000);
  });
  it("取り下げはPOSTで送り、失敗の文面を呼び出し元へ返す", async () => {
    const requests: { path: string; method: string }[] = [];
    const api = createInboxApi(async (input, init) => {
      requests.push({
        path: input instanceof Request ? input.url : input.toString(),
        method: init?.method ?? "GET",
      });
      return requests.length === 1
        ? Response.json({ stoppedDependents: [3] })
        : Response.json(
            { error: { code: "runner_unavailable", message: "ランナーにつながりません" } },
            { status: 503 },
          );
    });
    expect(await api.withdraw("a b")).toEqual({ stoppedDependents: [3] });
    await expect(api.withdraw("c")).rejects.toThrow("ランナーにつながりません");
    expect(requests).toEqual([
      { path: "/api/issues/a%20b/withdraw", method: "POST" },
      { path: "/api/issues/c/withdraw", method: "POST" },
    ]);
  });
  it("changedが続いても1秒に1回読み、対象projectだけを入れ替える", async () => {
    const { api, store } = fixture();
    const view = store.overview("p");
    const stop = [
      store.inbox.subscribe(() => {}),
      store.projects.subscribe(() => {}),
      view.subscribe(() => {}),
    ];
    await Promise.all([store.inbox.load(), store.projects.load(), view.load()]);
    const next = response(row());
    api.inbox.mockResolvedValue(next);
    store.receive({ topic: "inbox", seq: 0, type: "changed", payload: { project_ids: ["q"] } });
    await vi.advanceTimersByTimeAsync(500);
    store.receive({ topic: "inbox", seq: 0, type: "changed", payload: { project_ids: ["q"] } });
    expect(store.inbox.snapshot().data).toEqual(empty);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.inbox.snapshot().data).toEqual(next);
    expect(api.inbox).toHaveBeenCalledTimes(2);
    expect(api.projects).toHaveBeenCalledTimes(2);
    expect(api.overview).toHaveBeenCalledTimes(1);
    const nextOverview = { ...overview, project: { ...overview.project, name: "更新後" } };
    api.overview.mockResolvedValue(nextOverview);
    store.receive({ topic: "inbox", seq: 0, type: "changed", payload: { project_ids: ["p"] } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.snapshot().data).toEqual(nextOverview);
    expect(api.overview).toHaveBeenCalledTimes(2);
    stop.forEach((fn) => fn());
  });

  it("取得が失敗しても最後の一覧を残し、再接続で読み直してエラーを消す", async () => {
    const { api, store } = fixture();
    const stop = store.inbox.subscribe(() => {});
    await store.reload();
    api.inbox.mockRejectedValueOnce(new Error("サーバーにつながりません。"));
    await store.reload();
    expect(store.inbox.snapshot()).toEqual({
      data: empty,
      error: { code: "network_error", message: "サーバーにつながりません。" },
      loading: false,
      now: Date.now(),
    });
    const next = { sections: [] };
    api.inbox.mockResolvedValue(next);
    await store.reload();
    expect(store.inbox.snapshot()).toEqual({
      data: next,
      error: null,
      loading: false,
      now: Date.now(),
    });
    stop();
  });

  it("完了の展開をタブに残し、再表示でも全件を要求する", async () => {
    const { api, store } = fixture();
    const view = store.overview("p");
    const stop = view.subscribe(() => {});
    await view.load();
    await store.expandClosed("p");
    expect(api.overview.mock.calls).toEqual([
      ["p", false],
      ["p", true],
    ]);
    stop();
    const stopAgain = view.subscribe(() => {});
    await view.load();
    expect(api.overview.mock.calls).toEqual([
      ["p", false],
      ["p", true],
      ["p", true],
    ]);
    stopAgain();
  });
});
