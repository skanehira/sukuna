import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OpenedDatabase } from "../../../../shared/db/open";
import type { Directories } from "../../../../shared/env";
import { conversations, projects, settings } from "../../../../shared/db/schema";
import { restoreReceiptSchema } from "../../../../shared/settings/restore-schema";
import type { BackupItem } from "../../../../shared/settings/settings-schema";
import type { RunnerLink } from "../../../runner-link";
import type { SettingsDependencies } from "../domain/ports";
import { readKeymap } from "../usecase/get-settings";
import { keymapRevision } from "./keymap-revision";

import { backupFileId } from "../../../../shared/settings/backup-paths";
import type { LaunchdPort } from "../domain/launchd-port";
import { requestRestore } from "../usecase/request-restore";
import { createRestoreFiles } from "./restore-files";

const settingKeys = ["keymap", "flow_paused", "backup_status", "last_restore"];
const publicKeySchema = z.object({ publicKey: z.string().min(1) });

export function createSettingsDependencies(
  database: () => OpenedDatabase["db"],
  directories: Directories,
  changed: () => void,
  restore?: {
    launchd: Pick<LaunchdPort, "registered" | "kickstart">;
    now: () => number;
    receiptWarning?: (error: unknown) => void;
  },
  flow?: { runner(): Pick<RunnerLink, "forward">; inboxChanged(): void },
): SettingsDependencies {
  const files = createRestoreFiles(directories, restore?.receiptWarning);
  return {
    requestRestore: (backupId) =>
      requestRestore(backupId, {
        ...files,
        launchd: restore?.launchd ?? { registered: async () => false, kickstart: async () => {} },
        now: restore?.now ?? Date.now,
        id: randomUUID,
      }),
    restoreResult: (id) => {
      const result = files.lookup(id);
      if (result) return result;
      const row = database()
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "last_restore"))
        .get();
      const saved = restoreReceiptSchema.safeParse(row?.value).data;
      return saved?.requestId === id ? saved : undefined;
    },
    readValues: () =>
      new Map(
        database()
          .select()
          .from(settings)
          .where(inArray(settings.key, settingKeys))
          .all()
          .map(({ key, value }) => [key, value]),
      ),
    countRunningAi: () =>
      database()
        .select({ total: count() })
        .from(projects)
        .innerJoin(conversations, eq(conversations.projectId, projects.id))
        .where(
          and(
            isNull(projects.removedAt),
            inArray(conversations.runState, ["working", "waiting_answer", "waiting_permission"]),
          ),
        )
        .get()?.total ?? 0,
    listBackups: () => listBackups(join(directories.data, "backups")),
    readVapidPublicKey: () => readVapidPublicKey(join(directories.data, "vapid.json")),
    putKeymap: (value, revision) =>
      database().transaction(
        (db) => {
          if (revision !== undefined) {
            const saved = db
              .select({ value: settings.value })
              .from(settings)
              .where(eq(settings.key, "keymap"))
              .get()?.value;
            if (keymapRevision(readKeymap(saved)) !== revision) return false;
          }
          db.insert(settings)
            .values({ key: "keymap", value })
            .onConflictDoUpdate({ target: settings.key, set: { value } })
            .run();
          return true;
        },
        { behavior: "immediate" },
      ),
    changed,
    putFlowPaused: (value) => {
      database()
        .insert(settings)
        .values({ key: "flow_paused", value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
    },
    async notifyFlow() {
      await flow
        ?.runner()
        .forward("POST", "/flow/notify", {})
        .catch(() => {});
    },
    inboxChanged: () => flow?.inboxChanged(),
  };
}

async function listBackups(directory: string): Promise<BackupItem[]> {
  const files = (await optionalFile(() => readdir(directory, { withFileTypes: true }))) ?? [];
  const items = await Promise.all(
    files
      .filter((file) => file.isFile())
      .map(async ({ name }) => {
        const backup = backupFileId(name);
        if (!backup) return null;
        const file = await optionalFile(() => lstat(join(directory, name)));
        if (!file?.isFile()) return null;
        return {
          ...backup,
          createdAt: Math.trunc(file.mtimeMs),
          sizeBytes: file.size,
        } satisfies BackupItem;
      }),
  );
  return items
    .filter((item) => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

async function readVapidPublicKey(path: string): Promise<string | null> {
  const raw = await optionalFile(() => readFile(path, "utf8"));
  if (raw === null) return null;
  return publicKeySchema.parse(JSON.parse(raw)).publicKey;
}

async function optionalFile<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
