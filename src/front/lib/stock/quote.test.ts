import { expect, it } from "vite-plus/test";
import { makeQuote, type QuoteSource } from "./quote";

it("選んだ文字をUTF-16で保持し、区切りを会話の引用から外す", () => {
  const result = makeQuote(
    { kind: "conversation", positions: [{ seq: 2, line: 0 }, undefined, { seq: 5, line: 1 }] },
    ["A😀BC", "区切り", "後の文"],
    {
      mode: "char",
      ranges: [
        { line: 0, from: 1, to: 4 },
        { line: 1, from: 0, to: 3 },
        { line: 2, from: 0, to: 1 },
      ],
    },
  );
  expect(result).toEqual({
    kind: "conversation",
    mode: "char",
    text: "😀B\n後",
    start: { seq: 2, line: 0, col: 1 },
    end: { seq: 5, line: 1, col: 1 },
  });
});

it("Markdownの行は装飾の記号を含むソースの桁で引用する", () => {
  expect(
    makeQuote(
      { kind: "file", path: "docs/readme.md", positions: [{ line: 1 }] },
      ["# **見出し**"],
      { mode: "char", ranges: [{ line: 0, from: 4, to: 7 }] },
    ),
  ).toEqual({
    kind: "file",
    path: "docs/readme.md",
    mode: "char",
    text: "見出し",
    start: { line: 1, col: 4 },
    end: { line: 1, col: 7 },
  });
});

it("矩形の短い行をまたいでも右端の桁を保持する", () => {
  expect(
    makeQuote(
      { kind: "file", path: "a.txt", positions: [{ line: 1 }, { line: 2 }] },
      ["abcdef", "xy"],
      {
        mode: "block",
        ranges: [
          { line: 0, from: 1, to: 4 },
          { line: 1, from: 1, to: 2 },
        ],
      },
    ),
  ).toEqual({
    kind: "file",
    path: "a.txt",
    mode: "block",
    text: "bcd\ny",
    start: { line: 1, col: 1 },
    end: { line: 2, col: 4 },
  });
});

it("設計の差分は見出しを飛ばして変更後の行番号で数える", () => {
  const source: QuoteSource = {
    kind: "design_diff",
    path: "a.md",
    positions: [undefined, { line: 9 }],
  };
  expect(
    makeQuote(source, ["a.md", "+ 追記"], {
      mode: "line",
      ranges: [
        { line: 0, from: 0, to: 4 },
        { line: 1, from: 0, to: 4 },
      ],
    }),
  ).toEqual({
    kind: "design_diff",
    path: "a.md",
    mode: "line",
    text: "+ 追記",
    start: { line: 9, col: 0 },
    end: { line: 9, col: 4 },
  });
});

it("PRの削除と追加が同じ引用に入るときは両方の側を保つ", () => {
  const commit = "1111111111111111111111111111111111111111";
  expect(
    makeQuote(
      {
        kind: "pr_diff",
        path: "a.ts",
        commit,
        positions: [
          { line: 13, side: "old" },
          { line: 18, side: "new" },
        ],
      },
      ["- old", "+ new"],
      {
        mode: "line",
        ranges: [
          { line: 0, from: 0, to: 5 },
          { line: 1, from: 0, to: 5 },
        ],
      },
    ),
  ).toEqual({
    kind: "pr_diff",
    path: "a.ts",
    commit,
    mode: "line",
    text: "- old\n+ new",
    start: { side: "old", line: 13, col: 0 },
    end: { side: "new", line: 18, col: 5 },
  });
});

it("ターミナルの出力は選んだ文だけを保持する", () => {
  expect(
    makeQuote({ kind: "terminal" }, ["$ printf ok"], {
      mode: "char",
      ranges: [{ line: 0, from: 9, to: 11 }],
    }),
  ).toEqual({ kind: "terminal", mode: "char", text: "ok" });
});

it("位置がある選択にだけ引用を作る", () => {
  const source: QuoteSource = { kind: "conversation", positions: [undefined, { seq: 2, line: 0 }] };
  const lines = ["ここから未読", "発言"];
  expect(
    makeQuote(source, lines, { mode: "line", ranges: [{ line: 0, from: 0, to: 6 }] }),
  ).toBeNull();
  expect(makeQuote(source, lines, { mode: "line", ranges: [{ line: 1, from: 0, to: 2 }] })).toEqual(
    {
      kind: "conversation",
      mode: "line",
      text: "発言",
      start: { seq: 2, line: 0, col: 0 },
      end: { seq: 2, line: 0, col: 2 },
    },
  );
});

it("絵文字の右側だけにかかる矩形も別の行では選んだ桁だけを引用する", () => {
  expect(
    makeQuote(
      { kind: "file", path: "a.txt", positions: [{ line: 1 }, { line: 2 }, { line: 3 }] },
      ["ab😀cd", "x", "0123456789"],
      {
        mode: "block",
        block: { from: 2, to: 3 },
        ranges: [
          { line: 0, from: 2, to: 3 },
          { line: 1, from: 1, to: 1 },
          { line: 2, from: 2, to: 3 },
        ],
      },
    ),
  ).toEqual({
    kind: "file",
    path: "a.txt",
    mode: "block",
    text: "😀\n\n2",
    start: { line: 1, col: 2 },
    end: { line: 3, col: 3 },
  });
});

it("絵文字の左側にかかる矩形でも選択の開始桁は維持する", () => {
  expect(
    makeQuote(
      { kind: "file", path: "a.txt", positions: [{ line: 1 }, { line: 2 }, { line: 3 }] },
      ["abWXYZ", "ab😀cd", "abKLM"],
      {
        mode: "block",
        block: { from: 3, to: 4 },
        ranges: [0, 1, 2].map((line) => ({ line, from: 3, to: 4 })),
      },
    ),
  ).toEqual({
    kind: "file",
    mode: "block",
    path: "a.txt",
    text: "X\n😀\nL",
    start: { line: 1, col: 3 },
    end: { line: 3, col: 4 },
  });
});
