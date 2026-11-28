import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createBrowserController } from "./browser";

afterEach(() => vi.restoreAllMocks());

describe("ブラウザのタブ", () => {
  it("通知の URL を開き、画面の移動と戻る操作をそのタブの履歴につなぐ", () => {
    window.history.replaceState(null, "", "/conversations/c1?thread=t1");
    const open = vi.fn();
    const { controller, dispose } = createBrowserController(window, open);
    expect(open.mock.calls).toEqual([[{ kind: "conversation", id: "c1", thread: "t1" }]]);
    expect(controller.right.current).toEqual({ view: "thread", target: "t1", parent: "c1" });
    void controller.navigate("/issues/i1");
    expect(window.location.pathname).toBe("/issues/i1");
    expect(open.mock.calls.at(-1)).toEqual([{ kind: "issue", id: "i1" }]);
    dispose();
    window.history.replaceState(null, "", "/");
  });
  it("pagehide で位置を保存し、同じタブの再読み込みで右の表示と位置を戻す", () => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
    const first = createBrowserController(window, vi.fn());
    first.controller.positions.setPosition("/:main:home", { line: 4, column: 2, topLine: 1 });
    first.controller.openRight({ view: "toc", target: "c1" });
    window.dispatchEvent(new Event("pagehide"));
    first.dispose();
    const second = createBrowserController(window, vi.fn());
    expect(second.controller.positions.position("/:main:home")).toEqual({
      line: 4,
      column: 2,
      topLine: 1,
    });
    expect(second.controller.right.current).toEqual({ view: "toc", target: "c1" });
    second.dispose();
    window.sessionStorage.clear();
  });
});

describe("issue の画面内の履歴", () => {
  it.each([
    ["/issues/i1/log", true],
    ["/issues/i1?view=design", true],
    ["/issues/i2/log", false],
    ["/conversations/c1", false],
    ["/projects/p1", false],
  ])("%s は対象が同じ issue のときだけ置き換える", (url, replace) => {
    window.history.replaceState({ sukunaDepth: 0 }, "", "/issues/i1");
    const { controller, dispose } = createBrowserController(window, vi.fn());
    const push = vi.spyOn(window.history, "pushState");
    const replacement = vi.spyOn(window.history, "replaceState");
    void controller.navigate(url);
    expect({
      pushes: push.mock.calls,
      replacements: replacement.mock.calls,
      state: window.history.state,
    }).toEqual({
      pushes: replace ? [] : [[{ sukunaDepth: 1 }, "", url]],
      replacements: replace ? [[{ sukunaDepth: 0 }, "", url]] : [],
      state: { sukunaDepth: replace ? 0 : 1 },
    });
    push.mockRestore();
    replacement.mockRestore();
    dispose();
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
  });
});
