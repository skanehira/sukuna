import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KeymapConfig, KeymapEntry } from "../../shared/settings/keymap-schema";
import type { Settings } from "../../shared/settings/settings-schema";
import { Layout } from "../buffer/Layout";
import { BufferController } from "../buffer/controller";
import { createSettingsStore } from "../lib/settings-store";
import { registerSettingsCommands } from "../lib/settings-workspace";
import { SettingsPage } from "./settings";

const entries: KeymapEntry[] = [
  { keys: "Q", context: "normal", to: { action: "open" } },
  { keys: "Z", context: "normal", to: null },
];

describe("設定画面", () => {
  it("前回の成功日時が残っていても、ファイルが無ければまだありませんと表示する", async () => {
    const store = createSettingsStore({
      load: async () => ({
        keymap: { version: 1, entries: [] },
        flowPaused: false,
        runningAiCount: 0,
        lastRestore: null,
        push: { vapidPublicKey: null },
        backup: {
          schedule: "03:00",
          items: [],
          lastError: null,
          lastAt: Date.UTC(2026, 10, 26, 3),
        },
      }),
      replace: async (entries) => ({ version: 1, entries }),
    });
    const controller = new BufferController({ keymap: store.keymap });
    const { container } = render(
      <Layout
        controller={controller}
        main={<SettingsPage store={store} formatTime={() => "11/26 03:00"} />}
      />,
    );
    await waitFor(() => expect(container.textContent).toContain("毎日 03:00  (まだありません)"));
  });

  it.each([false, true])(
    "バックアップの最終結果と割り当てを表示し、確認して既定へ戻す (failure=%s)",
    async (failure) => {
      const backup = {
        schedule: "03:00",
        lastAt: Date.UTC(2026, 10, 26, 3, 0),
        lastError: failure ? "空き容量がありません" : null,
        items: [
          { id: "2026-11-26", kind: "daily", createdAt: 0, sizeBytes: 1 },
          {
            id: "before-restore-20261125-101500",
            kind: "before_restore",
            createdAt: 0,
            sizeBytes: 1,
          },
        ],
      } satisfies Settings["backup"];
      let keymap: KeymapConfig = { version: 1, entries };
      const load = vi.fn(async () => ({
        keymap,
        backup,
        flowPaused: false,
        runningAiCount: 0,
        lastRestore: null,
        push: { vapidPublicKey: null },
      }));
      const replace = vi.fn(async (entries: KeymapEntry[]) => {
        keymap = { version: 1, entries };
        return keymap;
      });
      const store = createSettingsStore({ load, replace });
      const navigate = vi.fn();
      const controller = new BufferController({ keymap: store.keymap, navigate });
      const unregister = registerSettingsCommands(controller);
      const { container } = render(
        <Layout
          controller={controller}
          main={<SettingsPage store={store} formatTime={() => "11/26 03:00"} />}
        />,
      );
      await waitFor(() =>
        expect(container.textContent).toContain(
          failure
            ? "毎日 03:00  (最終: 失敗 11/26 03:00 空き容量がありません)"
            : "毎日 03:00  (最終: 11/26 03:00、1 日分)",
        ),
      );
      expect(container.textContent).toContain("既定から 2 件を変更 (:map で変える)");
      await act(async () => controller.command(":set"));
      expect(navigate).toHaveBeenCalledWith("/settings");
      const chooseReset = async () => {
        const editor = screen.getByRole("textbox", { name: "バッファ" });
        const index = [...editor.querySelectorAll(".cm-line")].findIndex((line) =>
          line.textContent?.includes("キーの割り当てを既定に戻す"),
        );
        expect(index).toBeGreaterThanOrEqual(0);
        await act(async () => controller.command(String(index + 1)));
        act(() => controller.open());
        expect(screen.getByLabelText("操作の確認").textContent).toContain(
          "キーの割り当てを既定に戻しますか?",
        );
      };
      await chooseReset();
      await act(async () => controller.answer(new KeyboardEvent("keydown", { key: "n" })));
      expect(replace).not.toHaveBeenCalled();
      await chooseReset();
      await act(async () => controller.answer(new KeyboardEvent("keydown", { key: "y" })));
      expect(replace).toHaveBeenCalledExactlyOnceWith([]);
      await waitFor(() => expect(container.textContent).toContain("既定のまま"));
      unregister();
    },
  );
});
