import type Database from "better-sqlite3";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { backupFileId } from "../../../../shared/settings/backup-paths";

export function createBackupFiles(home: string, sqlite: Database.Database) {
  const dir = join(home, "backups");
  const daily = () =>
    readdirSync(dir, { withFileTypes: true })
      .filter((file) => file.isFile() && backupFileId(file.name)?.kind === "daily")
      .map((file) => file.name)
      .sort();
  return {
    prepare() {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (
          file.isFile() &&
          /^sukuna-\d{4}-\d{2}-\d{2}\.db\.tmp(?:-journal|-wal|-shm)?$/.test(file.name)
        )
          rmSync(join(dir, file.name));
      }
    },
    newest() {
      const newest = daily().at(-1);
      return newest === undefined
        ? undefined
        : { name: newest, writtenAt: statSync(join(dir, newest)).mtimeMs };
    },
    async write(day: string) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const output = join(dir, `sukuna-${day}.db`);
      const temporary = output + ".tmp";
      try {
        await sqlite.backup(temporary);
        chmodSync(temporary, 0o600);
        renameSync(temporary, output);
      } finally {
        for (const suffix of ["", "-journal", "-wal", "-shm"])
          rmSync(temporary + suffix, { force: true });
      }
    },
    keepLatest(count: number) {
      for (const name of daily().slice(0, -count)) rmSync(join(dir, name));
    },
    record(at: number, lastError: string | null) {
      sqlite
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_status', ?)")
        .run(JSON.stringify({ lastAt: at, lastError }));
    },
  };
}
