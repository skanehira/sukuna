import type { KeymapConfig, KeymapEntry } from "../../../../shared/settings/keymap-schema";
import type { SettingsDependencies } from "../domain/ports";

export function saveKeymap(
  entries: KeymapEntry[],
  dependencies: Pick<SettingsDependencies, "putKeymap" | "changed">,
  revision?: string,
): KeymapConfig | null {
  const keymap = { version: 1, entries } satisfies KeymapConfig;
  if (!dependencies.putKeymap(keymap, revision)) return null;
  dependencies.changed();
  return keymap;
}
