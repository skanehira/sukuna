import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { isStale } from "./staleness";
const line = fc
  .array(fc.constantFrom("あ", "😀", "x", " "), { minLength: 1, maxLength: 30 })
  .map((chars) => chars.join(""));
test.prop([fc.array(line, { minLength: 1, maxLength: 8 })])(
  "行の引用は一致する範囲で新しく、同じ位置の文が変われば古い",
  (lines) => {
    const quote = {
      kind: "file",
      mode: "line",
      path: "a",
      text: lines.join("\n"),
      start: { line: 1, col: 0 },
      end: { line: lines.length, col: lines.at(-1)!.length },
    } as const;
    expect(isStale(quote, lines.join("\n"))).toBe(false);
    expect(isStale(quote, `変更${lines.join("\n")}`)).toBe(true);
  },
);
test.prop([line, fc.nat(20), fc.nat(20)])(
  "文字と矩形の引用はバッファのUTF-16の位置から切り出した文を保つ",
  (text, a, b) => {
    const chars = Array.from(text);
    const start = Math.min(a % chars.length, b % chars.length);
    const end = Math.max(a % chars.length, b % chars.length) + 1;
    for (const mode of ["char", "block"] as const) {
      const quote = {
        kind: "file",
        mode,
        path: "a",
        text: chars.slice(start, end).join(""),
        start: { line: 1, col: chars.slice(0, start).join("").length },
        end: { line: 1, col: chars.slice(0, end).join("").length },
      } as const;
      expect(isStale(quote, text)).toBe(false);
      expect(isStale({ ...quote, text: `変更${quote.text}` }, text)).toBe(true);
    }
  },
);
