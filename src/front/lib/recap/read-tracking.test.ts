import { expect, it, vi } from "vite-plus/test";
import { ReadTracking, rememberOpening, forgetOpening } from "./read-tracking";

it("区切りと前回位置を再読込まで保ち、会話から離れると消す", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  expect(rememberOpening(storage, "c", 2, 1)).toEqual({ lastReadSeq: 2, lastPosition: 1 });
  expect(rememberOpening(storage, "c", 9, 8)).toEqual({ lastReadSeq: 2, lastPosition: 1 });
  forgetOpening(storage, "c");
  expect(rememberOpening(storage, "c", 9, 8)).toEqual({ lastReadSeq: 9, lastPosition: 8 });
});
it("初期既読を送り、届いたイベントを1秒でまとめ、隠れたタブでは進めず、2秒の停止と離脱に位置を送る", async () => {
  vi.useFakeTimers();
  const sent: unknown[] = [];
  const tracking = new ReadTracking(
    (body, keepalive) => {
      sent.push({ body, keepalive });
      return Promise.resolve();
    },
    (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  );
  tracking.open(4);
  tracking.received(5);
  tracking.received(6);
  tracking.cursor(3);
  await vi.advanceTimersByTimeAsync(1000);
  tracking.visibility(false);
  tracking.received(7);
  await vi.advanceTimersByTimeAsync(1000);
  tracking.visibility(true);
  await vi.advanceTimersByTimeAsync(1000);
  tracking.cursor(5);
  tracking.leave();
  expect(sent).toEqual([
    { body: { readSeq: 4 }, keepalive: false },
    { body: { readSeq: 6 }, keepalive: false },
    { body: { position: 3 }, keepalive: false },
    { body: { readSeq: 7 }, keepalive: false },
    { body: { position: 5 }, keepalive: true },
  ]);
  vi.useRealTimers();
});

it.each([
  { label: "会話から離れる", hide: false },
  { label: "隠れたタブを閉じる", hide: true },
])("$label とき送信待ちの既読を送る", async ({ hide }) => {
  vi.useFakeTimers();
  try {
    const sent: unknown[] = [];
    const tracking = new ReadTracking(
      async (body, keepalive) => {
        sent.push({ body, keepalive });
      },
      (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    );
    tracking.open(1);
    await vi.advanceTimersByTimeAsync(0);
    tracking.received(2);
    await vi.advanceTimersByTimeAsync(250);
    if (hide) {
      tracking.visibility(false);
      tracking.received(3);
    }
    tracking.leave();
    tracking.leave();
    await vi.advanceTimersByTimeAsync(750);
    expect(sent).toEqual([
      { body: { readSeq: 1 }, keepalive: false },
      { body: { readSeq: 2 }, keepalive: true },
    ]);
  } finally {
    vi.useRealTimers();
  }
});
