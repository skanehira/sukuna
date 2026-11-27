import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { compareInboxRows, type OrderedRow } from "./order";
const row = fc.record({
  id: fc.ulid(),
  unread: fc.boolean(),
  priority: fc.constantFrom<OrderedRow["priority"]>(null, "high", "medium", "low"),
  lastActivityAt: fc.integer({ min: 0, max: 999999 }),
});
test.prop([row, row])("優先度や更新日時に関係なく未読の行を先に並べる", (a, b) => {
  const unread = { ...a, unread: true };
  const read = { ...b, unread: false };
  expect([read, unread].sort(compareInboxRows)).toEqual([unread, read]);
});
test.prop([row, row, fc.constantFrom<OrderedRow["priority"]>("medium", "low", null)])(
  "未読が同じなら高優先度のissueを先に並べる",
  (a, b, priority) => {
    const high: OrderedRow = { ...a, priority: "high" };
    const other = { ...b, unread: a.unread, priority };
    expect([other, high].sort(compareInboxRows)).toEqual([high, other]);
  },
);
test.prop([row, fc.integer({ min: 1, max: 10000 })])(
  "他の順位が同じなら新しい更新を先に並べる",
  (r, delta) => {
    const newer = { ...r, lastActivityAt: r.lastActivityAt + delta };
    expect([r, newer].sort(compareInboxRows)).toEqual([newer, r]);
  },
);
test.prop([row, fc.uniqueArray(fc.ulid(), { minLength: 2, maxLength: 30 })])(
  "未読・優先度・更新が同じなら識別子の大きい順になる",
  (r, ids) => {
    expect(ids.map((id) => ({ ...r, id })).sort(compareInboxRows)).toEqual(
      [...ids]
        .sort()
        .reverse()
        .map((id) => ({ ...r, id })),
    );
  },
);
