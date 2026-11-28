import { expect, it } from "vite-plus/test";
import type { Quote, StockItem } from "../../../shared/stock";
import { stockMarks } from "./marks";

const quote = {
  kind: "file",
  path: "a.ts",
  mode: "line",
  text: "a\nb",
  start: { line: 2, col: 0 },
  end: { line: 3, col: 1 },
} satisfies Quote;
const item = (id: string, fields: Partial<StockItem> = {}): StockItem => ({
  id,
  conversationId: "c",
  kind: "instruction",
  text: "指示",
  quote,
  state: "stocked",
  stale: false,
  sentAt: null,
  sentSeq: null,
  thread: null,
  githubCommentUrl: null,
  ...fields,
});
const source = {
  kind: "file" as const,
  path: "a.ts",
  positions: [{ line: 1 }, { line: 2 }, { line: 3 }],
};
const lines = ["無関係", "a", "b"];

it("選択中は›が最優先で、保存した指示は質問やスレッドより先に出る", () => {
  const items = [
    item("send", { state: "sent", sentSeq: 7 }),
    item("thread", {
      state: "sent",
      kind: "question",
      thread: { id: "t", title: null, runState: "idle", closed: false },
    }),
    item("question", { kind: "question" }),
    item("b"),
    item("a"),
  ];
  expect([...stockMarks(source, lines, items, quote)]).toEqual([
    [1, { symbol: "›" }],
    [2, { symbol: "›" }],
  ]);
  expect([...stockMarks(source, lines, items)]).toEqual([
    [1, { symbol: "!", item: items[4] }],
    [2, { symbol: "!", item: items[4] }],
  ]);
  expect([...stockMarks(source, lines, items.slice(0, 3))]).toEqual([
    [1, { symbol: "?", item: items[2] }],
    [2, { symbol: "?", item: items[2] }],
  ]);
  expect([...stockMarks(source, lines, items.slice(0, 2))]).toEqual([
    [1, { symbol: "»", item: items[1] }],
  ]);
  const closed = item("closed", {
    state: "sent",
    kind: "question",
    thread: { id: "t", title: null, runState: "idle", closed: true },
  });
  expect([...stockMarks(source, lines, [items[0], closed])]).toEqual([
    [1, { symbol: "✓", item: closed }],
  ]);
  expect([...stockMarks(source, lines, [items[0]])]).toEqual([
    [1, { symbol: "→", item: items[0] }],
  ]);
});

it("古いファイルの引用には印を付けず、新しい引用だけの印を残す", () => {
  const kept = item("question", { kind: "question" });
  expect([...stockMarks(source, lines, [item("stale", { stale: true }), kept])]).toEqual([
    [1, { symbol: "?", item: kept }],
    [2, { symbol: "?", item: kept }],
  ]);
});

it("差分の位置と側が一致しても引用の先頭で始まらない行には印を付けない", () => {
  const commit = "1111111111111111111111111111111111111111";
  const pr = item("pr", {
    quote: {
      kind: "pr_diff",
      path: "a.ts",
      commit,
      mode: "char",
      text: "+ next",
      start: { line: 5, col: 0, side: "new" },
      end: { line: 5, col: 6, side: "new" },
    },
  });
  expect([
    ...stockMarks(
      {
        kind: "pr_diff",
        path: "a.ts",
        commit,
        positions: [
          { line: 5, side: "old" },
          { line: 5, side: "new" },
          { line: 5, side: "new" },
        ],
      },
      ["+ next", "+ other", "+ next value"],
      [pr],
    ),
  ]).toEqual([[2, { symbol: "!", item: pr }]]);
});
