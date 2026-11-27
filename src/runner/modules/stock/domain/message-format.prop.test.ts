import { expect } from "vite-plus/test";
import { fc, test } from "@fast-check/vitest";
import { formatStockItem } from "./message-format";

test.prop([
  fc.array(
    fc.string().filter((line) => !line.includes("\n")),
    { minLength: 1 },
  ),
  fc.string(),
])("引用のすべての行を > で始め、末尾に本文全体を保存する", (lines, text) => {
  expect(
    formatStockItem({ quote: { kind: "terminal", mode: "line", text: lines.join("\n") }, text }),
  ).toBe(["ターミナルの出力から", ...lines.map((line) => `> ${line}`), text].join("\n"));
});
