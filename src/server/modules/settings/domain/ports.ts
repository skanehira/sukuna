import type { KeymapConfig } from "../../../../shared/settings/keymap-schema";
import type { BackupItem } from "../../../../shared/settings/settings-schema";

export type SettingsDependencies = {
  readValues(): Map<string, unknown>;
  countRunningAi(): number;
  listBackups(): Promise<BackupItem[]>;
  readVapidPublicKey(): Promise<string | null>;
  putKeymap(keymap: KeymapConfig, revision?: string): boolean;
  changed(): void;
};
