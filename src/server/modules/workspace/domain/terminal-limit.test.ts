import { err, ok } from "neverthrow";
import { expect, it } from "vite-plus/test";
import { checkRunningTerminals } from "./terminal-limit";

it("動いているターミナルが 19 個なら開け、20 個なら競合を返す", () => {
  expect([checkRunningTerminals(19), checkRunningTerminals(20)]).toEqual([
    ok(undefined),
    err({
      code: "conflict",
      message: "ターミナルが 20 個動いています。使わないシェルを exit で終えてください",
    }),
  ]);
});
