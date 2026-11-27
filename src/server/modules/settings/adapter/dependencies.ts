import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OpenedDatabase } from "../../../../shared/db/open";
import { conversations, projects, settings } from "../../../../shared/db/schema";
import type { BackupItem } from "../../../../shared/settings/settings-schema";
import type { SettingsDependencies } from "../domain/ports";
import { readKeymap } from "../usecase/get-settings";
import { keymapRevision } from "./keymap-revision";

const settingKeys = ["keymap", "flow_paused", "backup_status", "last_restore"];
const publicKeySchema = z.object({ publicKey: z.string().min(1) });

export function createSettingsDependencies(
  database: () => OpenedDatabase["db"],
  home: string,
  changed: () => void,
): SettingsDependencies {
  return {
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
    listBackups: () => listBackups(join(home, "backups")),
    readVapidPublicKey: () => readVapidPublicKey(join(home, "vapid.json")),
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
  };
}

async function listBackups(directory: string): Promise<BackupItem[]> {
  const files = (await optionalFile(() => readdir(directory, { withFileTypes: true }))) ?? [];
  const items = await Promise.all(
    files
      .filter((file) => file.isFile())
      .map(async ({ name }) => {
        const daily = /^sukuna-(\d{4}-\d{2}-\d{2})\.db$/.exec(name);
        const beforeRestore = /^(before-restore-\d{8}-\d{6})\.db$/.exec(name);
        const id = daily?.[1] ?? beforeRestore?.[1];
        if (id === undefined) return null;
        const file = await optionalFile(() => lstat(join(directory, name)));
        if (!file?.isFile()) return null;
        return {
          id,
          kind: daily ? "daily" : "before_restore",
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
