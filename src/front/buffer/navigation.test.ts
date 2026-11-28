import { describe, expect, it, vi } from "vite-plus/test";
import { RightWindow } from "./right-window";
import { PositionStore } from "./position-store";
import { JumpHistory } from "./jump-history";
import { openRoute, routeUrl } from "../lib/routes";
import { browserClipboard, copyText } from "./clipboard";

describe("右のウィンドウ", () => {
  it("別の表示を積み、前の表示へ戻り、最後は閉じる", () => {
    const right = new RightWindow();
    right.open({ view: "toc", target: "c1" });
    right.open({ view: "stock", target: "c1" });
    right.open({ view: "stock", target: "c1" });
    expect(right.back()).toEqual({ view: "toc", target: "c1" });
    expect(right.back()).toBeNull();
  });
  it("会話・issue・ファイルへの移動は保ち、直近とほかの画面では閉じる", () => {
    const right = new RightWindow();
    right.open({ view: "toc", target: "c1" });
    right.navigate("issue", "i1");
    expect(right.current).toEqual({ view: "toc", target: "i1" });
    right.navigate("home", "");
    expect(right.current).toBeNull();
    right.open({ view: "recent", target: "c1" });
    right.navigate("conversation", "c2");
    expect(right.current).toBeNull();
  });
});

describe("タブごとの位置", () => {
  it("300ms 後とページを離れるときに書き、再生成でカーソルと右の表示を戻す", () => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const store = new PositionStore(storage, {
      schedule: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    store.setPosition("/conversations/c1:main", { line: 3, column: 2, topLine: 1, id: "event:1" });
    store.setRight({ current: { view: "toc", target: "c1" }, stack: [] });
    store.setActive("right");
    expect(values.size).toBe(0);
    vi.advanceTimersByTime(300);
    expect(values.size).toBe(1);
    const restored = new PositionStore(storage);
    expect(restored.position("/conversations/c1:main")).toEqual({
      line: 3,
      column: 2,
      topLine: 1,
      id: "event:1",
    });
    expect(restored.right()).toEqual({ current: { view: "toc", target: "c1" }, stack: [] });
    expect(restored.active()).toBe("right");
    store.setPosition("/conversations/c1:main", { line: 4, column: 0, topLine: 2 });
    store.flush();
    expect(new PositionStore(storage).position("/conversations/c1:main")).toEqual({
      line: 4,
      column: 0,
      topLine: 2,
    });
    vi.useRealTimers();
  });
  it("200 件を越えた位置と 50 件を越えた履歴は古いものから落とす", () => {
    const store = new PositionStore();
    for (let i = 0; i < 201; i += 1)
      store.setPosition(String(i), { line: i, column: 0, topLine: i });
    expect(store.position("0")).toBeNull();
    expect(store.position("200")).toEqual({ line: 200, column: 0, topLine: 200 });
    for (let i = 0; i < 51; i += 1) store.addCommand(String(i));
    expect(store.commands()).toEqual(Array.from({ length: 50 }, (_, i) => String(50 - i)));
  });
});

describe("ジャンプ", () => {
  it("別画面の位置へは画面を開いたあとに移り、積んだだけでは移らない", async () => {
    const store = new PositionStore();
    const history = new JumpHistory(store);
    const calls: unknown[] = [];
    history.push({ url: "/conversations/c1", window: "main", line: 8, id: "event:8" });
    expect(calls).toEqual([]);
    await history.back("/issues/i1", {
      open: async (url) => {
        calls.push(url);
      },
      place: (entry) => {
        calls.push(entry);
      },
    });
    expect(calls).toEqual([
      "/conversations/c1",
      { url: "/conversations/c1", window: "main", line: 8, id: "event:8" },
    ]);
    expect(history.pop()).toBeNull();
  });
});

describe("通知の URL", () => {
  it.each([
    ["/conversations/c1", { kind: "conversation", id: "c1" }],
    ["/issues/i1", { kind: "issue", id: "i1" }],
    ["/conversations/c1?thread=t1", { kind: "conversation", id: "c1", thread: "t1" }],
  ])("%s で対象を開く", (url, route) => {
    const open = vi.fn();
    openRoute(url, open);
    expect(open.mock.calls).toEqual([[route]]);
    expect(routeUrl(route)).toBe(url);
  });
});

describe("コピー", () => {
  it("安全でないオリジンでは fallback に選んだ文字を渡す", async () => {
    const fallback = vi.fn(() => true);
    const write = vi.fn();
    const notify = vi.fn();
    await copyText("選んだ文字", { secure: false, write, fallback, notify });
    expect(fallback.mock.calls).toEqual([["選んだ文字"]]);
    expect(write.mock.calls).toEqual([]);
    expect(notify.mock.calls).toEqual([]);
  });
  it("安全なオリジンでは Clipboard を使い、失敗は通知する", async () => {
    const write = vi.fn(async () => {
      throw new Error("denied");
    });
    const notify = vi.fn();
    await copyText("選んだ文字", { secure: true, write, fallback: vi.fn(), notify });
    expect(write.mock.calls).toEqual([["選んだ文字"]]);
    expect(notify.mock.calls).toEqual([
      ["クリップボードに書けませんでした。Vim のレジスタには入っています", "error"],
    ]);
  });
  it("macOS かをプラットフォームの名前で決め、読んだ中身を画像のファイルと文字に分ける", async () => {
    const blobs: Record<string, Blob> = {
      "image/png": new Blob(["png"], { type: "image/png" }),
      "text/plain": new Blob(["貼る文字"], { type: "text/plain" }),
    };
    const navigator = (platform: string) =>
      ({
        platform,
        clipboard: {
          read: async () => [
            { types: Object.keys(blobs), getType: async (type: string) => blobs[type] },
          ],
        },
      }) as unknown as Navigator;
    const mac = browserClipboard(document, navigator("MacIntel"), true, vi.fn());
    const content = await mac.read!();
    expect({
      mac: mac.mac,
      other: browserClipboard(document, navigator("Win32"), true, vi.fn()).mac,
      images: content.images.map((file) => [file.name, file.type]),
      text: content.text,
    }).toEqual({
      mac: true,
      other: false,
      images: [["clipboard.png", "image/png"]],
      text: "貼る文字",
    });
  });
});

it("同じ会話のファイルと再読込で右のスレッドを保ち、別の親に移すと古い履歴を除く", () => {
  const thread = { view: "stock-thread", target: "t1", parent: "c1" };
  const list = { view: "stock-thread-list", target: "c1" };
  const right = new RightWindow();
  right.open(list);
  right.open(thread);
  right.navigate("file", "c1");
  expect(right.state()).toEqual({ current: thread, stack: [list] });
  const values = new Map<string, string>();
  const store = new PositionStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  });
  store.setRight(right.state());
  store.flush();
  const restored = new RightWindow(
    new PositionStore({ getItem: (key) => values.get(key) ?? null, setItem: () => {} }).right(),
  );
  restored.navigate("conversation", "c1");
  expect(restored.current).toEqual(thread);
  restored.open({ view: "stock-list", target: "c1" });
  restored.navigate("conversation", "c2");
  expect(restored.state()).toEqual({
    current: { view: "stock-list", target: "c2" },
    stack: [{ view: "stock-thread-list", target: "c2" }],
  });
});
