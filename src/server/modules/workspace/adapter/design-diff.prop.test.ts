import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { parseDesignDiff } from "./design-diff";

const fileLine = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((line) => !/[\r\n\0]/.test(line));
const lines = fc.array(fileLine, { minLength: 1, maxLength: 10 });

test.prop([
  fc.integer({ min: 1, max: 1000 }),
  fc.integer({ min: 1, max: 1000 }),
  lines,
  lines,
  lines,
])("削除は旧側、追加は新側、共通行は両側の行番号を進める", (oldStart, newStart, del, add, ctx) => {
  const patch = [
    ":100644 100644 aa1 bb2 M\0設計.md\0\0diff --git a/設計.md b/設計.md",
    `@@ -${oldStart},${del.length + ctx.length} +${newStart},${add.length + ctx.length} @@`,
    ...del.map((line) => `-${line}`),
    ...add.map((line) => `+${line}`),
    ...ctx.map((line) => ` ${line}`),
  ].join("\n");
  expect(parseDesignDiff(patch)).toEqual([
    {
      path: "設計.md",
      status: "modified",
      binary: false,
      hunks: [
        {
          oldStart,
          newStart,
          oldLines: del.length + ctx.length,
          newLines: add.length + ctx.length,
          lines: [
            ...del.map((text, i) => ({ kind: "del", oldNo: oldStart + i, newNo: null, text })),
            ...add.map((text, i) => ({ kind: "add", oldNo: null, newNo: newStart + i, text })),
            ...ctx.map((text, i) => ({
              kind: "ctx",
              oldNo: oldStart + del.length + i,
              newNo: newStart + add.length + i,
              text,
            })),
          ],
        },
      ],
    },
  ]);
});
