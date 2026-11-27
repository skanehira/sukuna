import { expect, it } from "vite-plus/test";
import { openPosition } from "./open-position";

const events = [
  { seq: 1, type: "assistant_text" },
  { seq: 2, type: "user_message" },
  { seq: 3, type: "assistant_text" },
  { seq: 4, type: "user_message" },
  { seq: 5, type: "assistant_text" },
];
it.each([
  { lastReadSeq: 2, working: false, expected: { seq: 3, unreadSeq: 3, recent: true, tail: false } },
  {
    lastReadSeq: 5,
    working: false,
    expected: { seq: 4, unreadSeq: null, recent: false, tail: false },
  },
  { lastReadSeq: 2, working: true, expected: { seq: 5, unreadSeq: 3, recent: true, tail: true } },
  {
    lastReadSeq: 5,
    working: true,
    expected: { seq: 5, unreadSeq: null, recent: false, tail: true },
  },
])("開く位置の4条件: $lastReadSeq / $working", ({ lastReadSeq, working, expected }) => {
  expect(openPosition(events, lastReadSeq, working)).toEqual(expected);
});
it("自分の発言がなければ末尾、空の会話では未読も直近もない", () => {
  expect(openPosition([events[0]], 1, false)).toEqual({
    seq: 1,
    unreadSeq: null,
    recent: false,
    tail: true,
  });
  expect(openPosition([], 0, false)).toEqual({
    seq: null,
    unreadSeq: null,
    recent: false,
    tail: true,
  });
});
