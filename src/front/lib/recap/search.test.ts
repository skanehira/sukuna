import { expect, it } from "vite-plus/test";
import { searchRecap } from "./search";
it("章・決定・本文を検索し、小文字なら大小を無視し、大文字を含むと区別する", () => {
  const source = {
    chapters: [{ text: "API", seq: 1 }],
    decisions: [{ text: "apiを使う", seq: 2 }],
    body: [{ text: "Api本文", seq: 3, seqLine: 1 }],
  };
  expect(searchRecap(source, "api")).toEqual({
    chapters: source.chapters,
    decisions: source.decisions,
    body: source.body,
    remaining: 0,
  });
  expect(searchRecap(source, "API")).toEqual({
    chapters: source.chapters,
    decisions: [],
    body: [],
    remaining: 0,
  });
});
it("本文の201件目からはほかn件にまとめる", () => {
  const body = Array.from({ length: 203 }, (_, i) => ({ text: "hit", seq: i + 1 }));
  expect(searchRecap({ chapters: [], decisions: [], body }, "hit")).toEqual({
    chapters: [],
    decisions: [],
    body: body.slice(0, 200),
    remaining: 3,
  });
});
