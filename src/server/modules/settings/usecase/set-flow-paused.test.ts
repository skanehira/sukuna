import { expect, it, vi } from "vite-plus/test";
import { setFlowPaused } from "./set-flow-paused";

it("保存に失敗したときは設定変更をランナーや画面へ知らせない", async () => {
  const changed = vi.fn();
  const inboxChanged = vi.fn();
  const notifyFlow = vi.fn(async () => {});
  const unavailable = new Error("保存失敗");

  await expect(
    setFlowPaused(true, {
      putFlowPaused: () => {
        throw unavailable;
      },
      changed,
      inboxChanged,
      notifyFlow,
    }),
  ).rejects.toBe(unavailable);
  expect(changed).not.toHaveBeenCalled();
  expect(inboxChanged).not.toHaveBeenCalled();
  expect(notifyFlow).not.toHaveBeenCalled();
});
