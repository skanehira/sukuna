import { describe, expect, it } from "vite-plus/test";
import { completeReleaseSchema, releaseReservationSchema, releaseReservationKey } from "./ipc";
describe.each([
  ["予約応答", releaseReservationSchema],
  ["解除要求", completeReleaseSchema],
] as const)("終了の%s", (_name, schema) => {
  it("空でないトークンを失わずに受け取る", () => {
    expect(schema.parse({ token: "reservation-token" })).toEqual({ token: "reservation-token" });
  });
  it.each([{}, { token: "" }, { token: 42 }])("不正なトークン入力を拒む (%j)", (input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});
it("実行の予約は会話ごとに専用の保存キーを使う", () => {
  expect(["a", "b"].map(releaseReservationKey)).toEqual(["runner-release:a", "runner-release:b"]);
});
