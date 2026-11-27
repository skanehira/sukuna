import { expect, it } from "vite-plus/test";
import { compareInboxRows } from "./order";
import { formatElapsed } from "./elapsed";
it("同じセクションでは未読、優先度、更新、識別子の順に並ぶ", () => {
  const rows = [
    { id: "1", unread: false, priority: "high", lastActivityAt: 100 },
    { id: "2", unread: true, priority: "low", lastActivityAt: 100 },
    { id: "3", unread: false, priority: null, lastActivityAt: 100 },
    { id: "4", unread: false, priority: "medium", lastActivityAt: 100 },
    { id: "5", unread: false, priority: "medium", lastActivityAt: 200 },
  ] as const;
  expect([...rows].sort(compareInboxRows).map((r) => r.id)).toEqual(["2", "1", "5", "4", "3"]);
});
it.each([
  [0, "0秒前"],
  [59999, "59秒前"],
  [60000, "1分前"],
  [3599999, "59分前"],
  [3600000, "1時間前"],
  [86399999, "23時間前"],
  [86400000, "1日前"],
  [172800000, "2日前"],
] as const)("経過 %i ms を %s と書く", (elapsed, expected) => {
  expect(formatElapsed(100, { now: () => 100 + elapsed })).toBe(expected);
});
