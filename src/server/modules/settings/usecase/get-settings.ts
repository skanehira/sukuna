import { keymapSchema } from "../../../../shared/settings/keymap-schema";
import {
  backupStatusSchema,
  restoreStatusSchema,
  type Settings,
} from "../../../../shared/settings/settings-schema";
import type { SettingsDependencies } from "../domain/ports";

export function readKeymap(value: unknown): Settings["keymap"] {
  return keymapSchema.safeParse(value).data ?? { version: 1, entries: [] };
}

export async function getSettings(deps: SettingsDependencies): Promise<Settings> {
  const [items, vapidPublicKey] = await Promise.all([
    deps.listBackups(),
    deps.readVapidPublicKey(),
  ]);
  const values = deps.readValues();
  return {
    keymap: readKeymap(values.get("keymap")),
    flowPaused: values.get("flow_paused") === true,
    runningAiCount: deps.countRunningAi(),
    backup: {
      ...(backupStatusSchema.safeParse(values.get("backup_status")).data ?? {
        lastAt: null,
        lastError: null,
      }),
      schedule: "03:00",
      items,
    },
    lastRestore: restoreStatusSchema.safeParse(values.get("last_restore")).data ?? null,
    push: { vapidPublicKey },
  };
}
