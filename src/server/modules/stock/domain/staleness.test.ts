import { expect, it } from "vite-plus/test";
import type { Quote } from "../../../../shared/stock";
import { isStale } from "./staleness";
const quote = {
  kind: "file",
  path: "a",
  mode: "char",
  text: "😀い\nうえ",
  start: { line: 1, col: 1 },
  end: { line: 2, col: 2 },
} satisfies Quote;
it.each([
  { mode: "char", text: "😀い\nうえ", stale: false },
  { mode: "char", text: "違う", stale: true },
  { mode: "line", text: "あ😀い\nうえお", stale: false },
  { mode: "block", text: "😀\nえお", stale: false },
] as const)("$mode で同じ範囲の文を比べる", ({ mode, text, stale }) => {
  expect(
    isStale(
      { ...quote, mode, text, end: { line: 2, col: mode === "block" ? 3 : 2 } },
      "あ😀い\nうえお\n次",
    ),
  ).toBe(stale);
});
it.each([undefined, "", "あ😀い", "あ\nうえお"])(
  "読めないか範囲が無いファイルは古い (%j)",
  (content) => {
    expect(isStale(quote, content)).toBe(true);
  },
);
it("ファイル以外の引用は古くならない", () => {
  expect(isStale({ kind: "terminal", mode: "line", text: "保存した文" }, undefined)).toBe(false);
});
it.each([
  { start: { line: 2, col: 0 }, end: { line: 1, col: 0 }, text: "", content: "a\nb" },
  { start: { line: 1, col: 0 }, end: { line: 3, col: 0 }, text: "a\nb", content: "a\nb" },
  { start: { line: 1, col: 2 }, end: { line: 2, col: 1 }, text: "\nb", content: "a\nb" },
  { start: { line: 1, col: 0 }, end: { line: 2, col: 2 }, text: "a\nb", content: "a\nb" },
])("ファイルから消えた位置の引用は切り出せた文が同じでも古い (%j)", ({ content, ...range }) => {
  expect(isStale({ ...quote, ...range }, content)).toBe(true);
});
it("行末から次の行までの文字引用は行末の桁も含めて新しい", () => {
  expect(
    isStale(
      { ...quote, text: "\nb", start: { line: 1, col: 1 }, end: { line: 2, col: 1 } },
      "a\nb",
    ),
  ).toBe(false);
});
it("文字の桁は既存バッファと同じUTF-16の位置で数える", () => {
  expect(
    isStale({ ...quote, text: "a", start: { line: 1, col: 2 }, end: { line: 1, col: 3 } }, "😀ab"),
  ).toBe(false);
});
it("引用の最後の行が消えたときは、残った行が同じでも古い", () => {
  const saved = {
    ...quote,
    mode: "line" as const,
    text: "a\nb\n",
    start: { line: 1, col: 0 },
    end: { line: 3, col: 0 },
  };
  expect(isStale(saved, "a\nb\n")).toBe(false);
  expect(isStale({ ...saved, text: "a\nb" }, "a\nb")).toBe(true);
});
