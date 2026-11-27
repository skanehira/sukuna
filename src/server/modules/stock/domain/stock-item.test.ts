import { describe, expect, it } from "vite-plus/test";
import { addStockSchema, patchStockSchema, quoteSchema } from "../../../../shared/stock";
import { transitionStock } from "./stock-item";

const terminal = { kind: "terminal", mode: "line", text: "引用" };
const pos = { line: 1, col: 0 };
const quotes = [
  {
    ...terminal,
    kind: "conversation",
    start: { ...pos, line: 0, seq: 1 },
    end: { ...pos, line: 0, seq: 1 },
  },
  { ...terminal, kind: "file", path: "src/a.ts", start: pos, end: pos },
  { ...terminal, kind: "design_diff", path: "docs/a.md", start: pos, end: pos },
  {
    ...terminal,
    kind: "pr_diff",
    path: "src/a.ts",
    commit: "a".repeat(40),
    start: { ...pos, side: "old" },
    end: { ...pos, side: "new" },
  },
  terminal,
];

describe("ストックの入力と状態", () => {
  it.each(quotes.flatMap((quote) => ["char", "line", "block"].map((mode) => ({ ...quote, mode }))))(
    "引用 $kind の $mode の形を保持する",
    (quote) => {
      expect(quoteSchema.parse(quote)).toEqual(quote);
    },
  );
  it.each([
    { ...terminal, kind: "unknown" },
    { ...quotes[0], start: { line: -1, col: 0, seq: 1 } },
    { ...quotes[0], start: { line: 0, col: 0, seq: 0 } },
    { ...quotes[1], start: { line: 0, col: 0 } },
    { ...quotes[1], end: { line: 1, col: -1 } },
    { ...quotes[1], path: 42 },
    { ...quotes[2], start: { line: 1.5, col: 0 } },
    { ...quotes[3], commit: "x".repeat(40) },
    { ...quotes[3], commit: "a".repeat(39) },
    { ...quotes[3], commit: "a".repeat(40) + "\n" },
    { ...quotes[3], start: { ...pos, side: "other" } },
    { ...terminal, mode: "other" },
    { ...terminal, start: pos },
  ])("形の違う引用を拒む (%j)", (quote) => {
    expect(quoteSchema.safeParse(quote).success).toBe(false);
  });
  it.each([0, 1, 10_000, 10_001])("本文 %i 文字の境界を検査する", (length) => {
    expect(
      addStockSchema.safeParse({ kind: "instruction", text: "あ".repeat(length), quote: terminal })
        .success,
    ).toBe(length >= 1 && length <= 10_000);
  });
  it.each([20_000, 20_001])("引用の文 %i 文字の境界を検査する", (length) => {
    expect(
      addStockSchema.safeParse({
        kind: "question",
        text: "質問",
        quote: { ...terminal, text: "あ".repeat(length) },
      }).success,
    ).toBe(length <= 20_000);
  });
  it.each([
    { text: "" },
    { text: "a", state: "stocked" },
    { state: "sent" },
    {},
    { text: "a", quote: terminal },
  ])("編集と復元の入力を混ぜられない (%j)", (input) => {
    expect(patchStockSchema.safeParse(input).success).toBe(false);
  });
  it.each(["stocked", "sent", "cancelled"] as const)("%s から許された操作だけが通る", (state) => {
    expect(
      ["edit", "cancel", "restore", "send"].map((action) => {
        const result = transitionStock(state, action as "edit" | "cancel" | "restore" | "send");
        return result.isOk() ? result.value : result.error.code;
      }),
    ).toEqual(
      state === "stocked"
        ? ["stocked", "cancelled", "conflict", "sent"]
        : state === "cancelled"
          ? ["conflict", "conflict", "stocked", "conflict"]
          : ["conflict", "conflict", "conflict", "conflict"],
    );
  });
});
