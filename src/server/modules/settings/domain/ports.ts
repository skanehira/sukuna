import type { KeymapConfig } from "../../../../shared/settings/keymap-schema";
import type { BackupItem } from "../../../../shared/settings/settings-schema";
import type { Result } from "neverthrow";
import type { RestoreLookup } from "../../../../shared/settings/restore-schema";

export type SettingsDependencies = {
  readValues(): Map<string, unknown>;
  countRunningAi(): number;
  listBackups(): Promise<BackupItem[]>;
  readVapidPublicKey(): Promise<string | null>;
  putKeymap(keymap: KeymapConfig, revision?: string): boolean;
  changed(): void;
  putFlowPaused(paused: boolean): void;
  notifyFlow(): Promise<void>;
  inboxChanged(): void;
  requestRestore?(
    backupId: string,
  ): Promise<
    Result<
      { restarting: true; requestId: string },
      { code: "not_found" | "conflict"; message: string }
    >
  >;
  restoreResult?(requestId: string): RestoreLookup | undefined;
};
