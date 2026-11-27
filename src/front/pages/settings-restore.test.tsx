import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import type { RestoreLookup } from "../../shared/settings/restore-schema";
import type { Settings } from "../../shared/settings/settings-schema";
import { BufferController } from "../buffer/controller";
import { Layout } from "../buffer/Layout";
import { createRestoreWorkspace } from "../lib/settings-restore";
import { createSettingsStore } from "../lib/settings-store";
import { SettingsPage } from "./settings";

const requestId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

function fixture() {
  let current: Settings = {
    keymap: { version: 1, entries: [] },
    flowPaused: false,
    runningAiCount: 1,
    backup: {
      schedule: "03:00",
      lastAt: 10,
      lastError: null,
      items: [
        {
          id: "before-restore-20261125-101500",
          kind: "before_restore",
          createdAt: 10,
          sizeBytes: 3_000_000,
        },
        { id: "2026-11-26", kind: "daily", createdAt: 20, sizeBytes: 12_000_000 },
      ],
    },
    lastRestore: null,
    push: { vapidPublicKey: null },
  };
  const store = createSettingsStore({
    load: async () => current,
    replace: async () => current.keymap,
  });
  const post = vi.fn(async (_id: string) => requestId);
  let result: RestoreLookup | null = { status: "pending" };
  const getResult = vi.fn(async (_id: string) => result);
  let timer: (() => void) | undefined;
  const schedule = (callback: () => void) => {
    timer = callback;
    return () => {
      timer = undefined;
    };
  };
  const notice = vi.fn();
  const controller = new BufferController({ keymap: store.keymap, notify: notice });
  const formatTime = (at: number) => (at === 20 ? "11/26 03:00" : "11/25 10:15");
  const restore = createRestoreWorkspace({
    controller,
    store,
    formatTime,
    post,
    getResult,
    schedule,
    finish: notice,
  });
  const dispose = restore.start();
  render(
    <Layout
      controller={controller}
      renderRight={(view) => restore.right(view)}
      main={<SettingsPage store={store} formatTime={formatTime} />}
    />,
  );
  return {
    restore,
    store,
    controller,
    notice,
    post,
    getResult,
    next: (value: RestoreLookup | null) => {
      result = value;
    },
    tick: async () => {
      await act(async () => {
        timer?.();
      });
    },
    dispose,
    set: (changed: Partial<Settings>) => {
      current = { ...current, ...changed };
    },
  };
}

async function openMenu(f: ReturnType<typeof fixture>) {
  await act(async () => f.store.refresh());
  await act(async () =>
    f.controller.run("settings.restore", { window: "main", view: "settings", line: 2 }),
  );
  const editor = await waitFor(() => {
    const panels = screen.getAllByRole("textbox", { name: "バッファ" });
    expect(panels).toHaveLength(2);
    return panels[1]!;
  });
  expect(editor.textContent).toContain("11/26 03:00");
  expect(editor.textContent).toContain("(復元の直前)");
  expect(editor.textContent!.indexOf("11/26 03:00")).toBeLessThan(
    editor.textContent!.indexOf("11/25 10:15"),
  );
  return editor;
}

it("直前の稼働件数で確認し、取り消した場合は送らない", async () => {
  const f = fixture();
  await openMenu(f);
  f.set({ runningAiCount: 4 });
  await act(async () =>
    f.controller.run("settings.restore-select", { window: "right", view: "backups", line: 0 }),
  );
  expect(screen.getByLabelText("操作の確認").textContent).toContain(
    "11/26 03:00 の内容に戻します。動いている AI 4 件を止めます。",
  );
  await act(async () => f.controller.answer(new KeyboardEvent("keydown", { key: "n" })));
  expect(f.post).not.toHaveBeenCalled();
  f.dispose();
});

it.each([
  {
    status: "done",
    message: null,
    notice:
      "11/26 03:00 のバックアップから戻しました。自動フローを一時停止しています。:resume で再開します。",
  },
  {
    status: "failed",
    message: "バックアップが壊れています。",
    notice: "バックアップが壊れています。",
  },
] as const)(
  "依頼した画面は接続後に新しい復元結果を出す (%s)",
  async ({ status, message, notice }) => {
    const f = fixture();
    await openMenu(f);
    await act(async () =>
      f.controller.run("settings.restore-select", { window: "right", view: "backups", line: 0 }),
    );
    await act(async () => f.controller.answer(new KeyboardEvent("keydown", { key: "y" })));
    await waitFor(() => expect(f.restore.restarting.snapshot()).toBe(true));
    expect(f.post).toHaveBeenCalledExactlyOnceWith("2026-11-26");
    expect(f.notice).toHaveBeenCalledWith(
      "復元しています。再起動のあと自動でつながります。",
      "info",
    );
    f.set({
      lastRestore: {
        status: "done",
        message: null,
        requestId: otherId,
        at: 50,
        backupId: "2026-11-26",
      },
    });
    await act(async () => f.store.refresh());
    await f.tick();
    expect(f.restore.restarting.snapshot()).toBe(true);
    expect(f.getResult.mock.calls.every(([id]) => id === requestId)).toBe(true);
    f.next({ status, message, at: 100, backupId: "2026-11-26", requestId });
    await f.tick();
    expect(f.restore.restarting.snapshot()).toBe(false);
    expect(f.notice).toHaveBeenCalledWith(notice, status === "done" ? "info" : "error");
    f.dispose();
  },
);

it("通信中断後に別の復元結果に置き換わっていたら、成功を誤表示せず待機を終える", async () => {
  const f = fixture();
  await openMenu(f);
  await act(async () =>
    f.controller.run("settings.restore-select", { window: "right", view: "backups", line: 0 }),
  );
  await act(async () => f.controller.answer(new KeyboardEvent("keydown", { key: "y" })));
  f.getResult.mockRejectedValueOnce(new Error("offline"));
  await f.tick();
  expect(f.restore.restarting.snapshot()).toBe(true);
  f.set({
    lastRestore: {
      status: "done",
      message: null,
      backupId: "2026-11-25",
      at: 200,
      requestId: otherId,
    },
  });
  await act(async () => f.store.refresh());
  f.next(null);
  await f.tick();
  expect(f.restore.restarting.snapshot()).toBe(false);
  expect(f.notice).toHaveBeenCalledWith(
    "この復元の結果を確認できませんでした。設定を読み直してください。",
    "error",
  );
  f.dispose();
});
