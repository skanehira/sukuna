import { expect, it } from "vite-plus/test";
import { createFlowGate } from "./flow-gate";

it.each([
  { global: true, paused: false, enabled: true },
  { global: false, paused: true, enabled: true },
  { global: false, paused: false, enabled: false },
])("自動処理を止めても開発者は操作できる %j", ({ global, paused, enabled }) => {
  const allows = createFlowGate({
    globallyPaused: () => global,
    settings: () => ({ flowPaused: paused, autoStages: enabled ? ["design"] : ["triage"] }),
  });
  expect([allows("p", "design"), allows("p", "design", "developer")]).toEqual([false, true]);
});

it("一時停止を解除したプロジェクトの設計を始められる", () => {
  const allows = createFlowGate({
    globallyPaused: () => false,
    settings: () => ({ flowPaused: false, autoStages: ["design"] }),
  });
  expect(allows("p", "design")).toBe(true);
});
