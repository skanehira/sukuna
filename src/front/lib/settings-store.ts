import { z } from "zod";
import {
  keymapSchema,
  type KeymapConfig,
  type KeymapEntry,
} from "../../shared/settings/keymap-schema";
import { settingsSchema, type Settings } from "../../shared/settings/settings-schema";
import type { KeymapPort } from "../buffer/keymap/registry";

type SettingsRead = Settings & { keymapRevision?: string };
type SettingsApi = {
  load(): Promise<SettingsRead>;
  replace(entries: KeymapEntry[], revision?: string): Promise<KeymapConfig | null>;
};

const apiMessage = z.object({ error: z.object({ message: z.string() }) });

export function createSettingsApi(fetcher: typeof fetch): SettingsApi {
  async function body(response: Response, fallback: string) {
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(apiMessage.safeParse(data).data?.error.message ?? fallback);
    return data;
  }
  return {
    async load() {
      const response = await fetcher("/api/settings");
      const settings = settingsSchema.parse(await body(response, "設定を読み込めませんでした。"));
      const revision = response.headers.get("X-Keymap-Revision");
      return revision === null ? settings : { ...settings, keymapRevision: revision };
    },
    async replace(entries, revision) {
      const response = await fetcher("/api/settings/keymap", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(revision === undefined ? {} : { "If-Match": revision }),
        },
        body: JSON.stringify({ entries }),
      });
      if (revision !== undefined && response.status === 412) return null;
      return keymapSchema.parse(await body(response, "キーの割り当てを保存できませんでした。"));
    },
  };
}

export function createSettingsStore(
  api: SettingsApi,
  onReadError: (error: unknown) => void = () => {},
) {
  let current: Settings | null = null;
  let savedKeymap: KeymapConfig | undefined;
  let readGeneration = 0;
  let latestRead: Promise<SettingsRead> | undefined;
  let pendingRead: Promise<SettingsRead> | undefined;
  let writesDone: Promise<void> | undefined;
  let finishWrites: (() => void) | undefined;
  let writes = 0;
  let refreshAfterWrite = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const refresh = (): Promise<SettingsRead> => {
    const generation = ++readGeneration;
    if (writes > 0) refreshAfterWrite = true;
    const request = api
      .load()
      .then((settings) => {
        if (generation === readGeneration && writes === 0) {
          current = settings;
          savedKeymap = settings.keymap;
          emit();
        }
        return settings;
      })
      .finally(() => {
        if (pendingRead === request) pendingRead = undefined;
      });
    latestRead = pendingRead = request;
    return request;
  };
  const keymap: KeymapPort = {
    load: async () => savedKeymap ?? (await (pendingRead ?? refresh())).keymap,
    async loadLatest() {
      if (writesDone) await writesDone;
      let requested = refresh();
      for (;;) {
        try {
          const settings = await requested;
          if (requested === latestRead && !writesDone) {
            return settings.keymapRevision === undefined
              ? settings.keymap
              : { ...settings.keymap, revision: settings.keymapRevision };
          }
        } catch (error) {
          if (requested === latestRead && !writesDone) throw error;
        }
        if (writesDone) await writesDone;
        requested = latestRead ?? refresh();
      }
    },
    subscribe,
    async replace(entries, revision) {
      refreshAfterWrite ||= pendingRead !== undefined;
      ++readGeneration;
      latestRead = undefined;
      if (writes++ === 0)
        writesDone = new Promise((resolve) => {
          finishWrites = resolve;
        });
      try {
        const keymap =
          revision === undefined
            ? await api.replace(entries)
            : await api.replace(entries, revision);
        if (keymap === null) return null;
        savedKeymap = keymap;
        if (current) current = { ...current, keymap };
        emit();
        return keymap;
      } finally {
        if (--writes === 0) {
          if (refreshAfterWrite) {
            refreshAfterWrite = false;
            void refresh().catch(onReadError);
          }
          finishWrites?.();
          finishWrites = undefined;
          writesDone = undefined;
        }
      }
    },
  };
  return { snapshot: () => current, subscribe, refresh, keymap };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
