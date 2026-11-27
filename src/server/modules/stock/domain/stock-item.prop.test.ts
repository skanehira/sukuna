import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { transitionStock } from "./stock-item";
import { addStockSchema } from "../../../../shared/stock";
test.prop([fc.array(fc.constantFrom("cancel", "restore"), { minLength: 1 })])(
  "取消と復元の列は、直前の状態に合う操作だけが保存状態を変える",
  (actions) => {
    let state: "stocked" | "cancelled" = "stocked";
    for (const action of actions) {
      const result = transitionStock(state, action);
      const allowed =
        (action === "cancel" && state === "stocked") ||
        (action === "restore" && state === "cancelled");
      expect(result.isOk()).toBe(allowed);
      if (result.isOk()) {
        const next = action === "cancel" ? "cancelled" : "stocked";
        expect(result.value).toBe(next);
        state = next;
      }
    }
  },
);
test.prop([fc.integer({ min: 1, max: 10_000 }), fc.constantFrom("a", "あ", "😀")])(
  "本文の文字数は補助平面の文字も1文字で数える",
  (length, char) => {
    expect(
      addStockSchema.safeParse({
        kind: "question",
        text: char.repeat(length),
        quote: { kind: "terminal", mode: "line", text: "" },
      }).success,
    ).toBe(true);
  },
);
