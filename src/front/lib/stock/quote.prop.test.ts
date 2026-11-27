import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { makeQuote } from "./quote";

test.prop([
  fc.array(fc.stringMatching(/^[a-z]{0,12}$/), { minLength: 1, maxLength: 20 }),
  fc.integer({ min: 0, max: 8 }),
  fc.integer({ min: 1, max: 4 }),
])("行の長さにかかわらず矩形の両端を保存し、各行から同じ桁を切り出す", (lines, left, width) => {
  const bounds = { from: left, to: left + width };
  const result = makeQuote(
    { kind: "file", path: "a.ts", positions: lines.map((_, index) => ({ line: index + 1 })) },
    lines,
    {
      mode: "block",
      block: bounds,
      ranges: lines.map((text, line) => ({
        line,
        from: Math.min(text.length, left),
        to: Math.min(text.length, left + width),
      })),
    },
  );
  expect(result).toEqual({
    kind: "file",
    mode: "block",
    path: "a.ts",
    text: lines.map((line) => line.slice(left, left + width)).join("\n"),
    start: { line: 1, col: left },
    end: { line: lines.length, col: left + width },
  });
});
