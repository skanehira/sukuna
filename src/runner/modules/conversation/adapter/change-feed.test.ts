import { expect, it, vi } from "vite-plus/test";
import { ChangeFeed } from "./change-feed";
import type { RunnerNotice } from "../../../../shared/ipc";
it("書きかけを100msでまとめ、購読解除後には送らない", () => {
  vi.useFakeTimers();
  try {
    const feed = new ChangeFeed({
      setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    const notices: RunnerNotice[] = [];
    const off = feed.subscribe((n) => notices.push(n));
    feed.delta("a", "one");
    feed.delta("a", "two");
    vi.advanceTimersByTime(99);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notices).toEqual([{ kind: "delta", conversation_id: "a", text: "onetwo" }]);
    off();
    feed.publish({ kind: "project", project_id: "p" });
    expect(notices).toEqual([{ kind: "delta", conversation_id: "a", text: "onetwo" }]);
    feed.close();
  } finally {
    vi.useRealTimers();
  }
});
