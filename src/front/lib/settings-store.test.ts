import { describe, expect, it, vi } from "vite-plus/test";
import type { KeymapConfig, KeymapEntry } from "../../shared/settings/keymap-schema";
import type { Settings } from "../../shared/settings/settings-schema";
import { createSettingsApi, createSettingsStore } from "./settings-store";

const defaults: Settings = {
  keymap: { version: 1, entries: [] },
  flowPaused: false,
  runningAiCount: 0,
  backup: { schedule: "03:00", lastAt: null, lastError: null, items: [] },
  lastRestore: null,
  push: { vapidPublicKey: null },
};
const entry = (keys: string): KeymapEntry => ({ keys, context: "normal", to: { action: "open" } });
const config = (keys: string): KeymapConfig => ({ version: 1, entries: [entry(keys)] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("端末間の設定", () => {
  it("保存前に始まった取得が遅れても、保存結果を取り消さず、その後の別タブの保存を反映する", async () => {
    const stale = deferred<Settings>();
    const remote = deferred<Settings>();
    const read = vi
      .fn(async () => defaults)
      .mockResolvedValueOnce(defaults)
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => remote.promise);
    const local = config("Q");
    const store = createSettingsStore({ load: read, replace: async () => local });
    await store.refresh();
    const olderRequest = store.refresh();
    await store.keymap.replace(local.entries);
    expect(await store.keymap.load()).toEqual(local);
    stale.resolve(defaults);
    await olderRequest;
    expect(store.snapshot()?.keymap).toEqual(local);

    const newer = config("W");
    const updated = deferred<Settings>();
    const unsubscribe = store.subscribe(() => {
      const value = store.snapshot();
      if (value) updated.resolve(value);
    });
    remote.resolve({ ...defaults, keymap: newer });
    expect((await updated.promise).keymap).toEqual(newer);
    expect(await store.keymap.load()).toEqual(newer);
    unsubscribe();
  });

  it("二つの通知が再確認の取得と重なっても、最後に採用したキーを渡す", async () => {
    const reads = [deferred<Settings>(), deferred<Settings>(), deferred<Settings>()];
    const load = vi.fn(async () => defaults).mockResolvedValueOnce(defaults);
    for (const read of reads) load.mockImplementationOnce(() => read.promise);
    const store = createSettingsStore({ load, replace: async () => defaults.keymap });
    await store.refresh();

    const beforeApproval = store.keymap.loadLatest!();
    const notification = store.refresh();
    const latest = config("Qz");
    reads[0].resolve({ ...defaults, keymap: config("Qp") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newerNotification = store.refresh();
    reads[1].resolve({ ...defaults, keymap: config("Qq") });
    await notification;
    reads[2].resolve({ ...defaults, keymap: latest });
    await newerNotification;

    expect(await beforeApproval).toMatchObject({ entries: latest.entries });
    expect(store.snapshot()?.keymap).toEqual(latest);
  });

  it("最後の読み直しに失敗したら、古い結果を確認の基準として返さない", async () => {
    const earlier = deferred<Settings>();
    const error = new Error("設定を読み直せません");
    const load = vi
      .fn(async () => defaults)
      .mockResolvedValueOnce(defaults)
      .mockImplementationOnce(() => earlier.promise)
      .mockRejectedValueOnce(error);
    const store = createSettingsStore({ load, replace: async () => defaults.keymap });
    await store.refresh();
    const fresh = store.keymap.loadLatest!();
    await expect(store.refresh()).rejects.toThrow(error.message);
    earlier.resolve({ ...defaults, keymap: config("Q") });
    await expect(fresh).rejects.toThrow(error.message);
    expect(store.snapshot()?.keymap).toEqual(defaults.keymap);
  });

  it("PUT が失敗したら応答の理由を返し、画面に保存前の割り当てを残す", async () => {
    const api = createSettingsApi(async (path, options) =>
      path === "/api/settings/keymap" && options?.method === "PUT"
        ? Response.json(
            { error: { code: "internal", message: "設定ファイルを更新できません" } },
            { status: 500 },
          )
        : Response.json(defaults),
    );
    const store = createSettingsStore(api);
    await store.refresh();
    await expect(store.keymap.replace([entry("Q")])).rejects.toThrow(
      "設定ファイルを更新できません",
    );
    expect(store.snapshot()?.keymap).toEqual(defaults.keymap);
  });
});
