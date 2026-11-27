import { describe, expect, it } from "vite-plus/test";
import { stateChangedSchema } from "./state";

describe("状態の記録の契約", () => {
  it("停止中の記録は停止前の状態、理由、1 行の説明、きっかけを読み書きできる", () => {
    const payload = {
      from: "design",
      to: "stopped",
      stopReason: "dependency_withdrawn",
      detail: "#2 #10",
      cause: "dependency_withdrawn",
    };

    expect(stateChangedSchema.parse(payload)).toEqual(payload);
  });

  it("初回の精査と停止からの復帰では空の理由と説明を保存できる", () => {
    const payloads = [
      { from: null, to: "triage", stopReason: null, detail: null, cause: "ai_created" },
      {
        from: "stopped",
        to: "design",
        stopReason: null,
        detail: null,
        cause: "dependency_cleared",
      },
    ];

    expect(payloads.map((payload) => stateChangedSchema.parse(payload))).toEqual(payloads);
  });

  it.each([
    { from: "unknown", to: "triage", stopReason: null, detail: null, cause: "confirm" },
    { from: "design", to: "stopped", stopReason: "unknown", detail: "失敗", cause: "agent_failed" },
    { from: "design", to: "stopped", stopReason: "failed", detail: "失敗", cause: "unknown" },
    { from: "design", to: "stopped", stopReason: "failed", detail: null, cause: "agent_failed" },
    { from: "design", to: "stopped", stopReason: "failed", detail: "1\n2", cause: "agent_failed" },
    { from: "stopped", to: "design", stopReason: "failed", detail: null, cause: "agent_resumed" },
  ])("不正な状態の記録 %j は保存前に拒む", (payload) => {
    expect(stateChangedSchema.safeParse(payload).success).toBe(false);
  });
});
