import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Directories } from "../../../../shared/env";
import type { RestoreRequest, RestoreStatus } from "../../../../shared/settings/restore-schema";
import { acquireLock } from "../../../../shared/db/startup";
import {
  putRestoreGeneration,
  putRestoreStatus,
  readRestoreRequest,
  readRestoreReceipt,
  writeRestoreReceipt,
  replaceRestoreValue,
  restoreWorkerLockPath,
  removeRestoreStaging,
} from "../../../../shared/db/restore-state";
import {
  backupFileId,
  backupFileName,
  beforeRestoreName,
} from "../../../../shared/settings/backup-paths";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export function createRestoreFiles(
  { data, state }: Directories,
  receiptWarning: (error: unknown) => void = () => {},
) {
  const dir = join(data, "backups");
  const marker = join(state, "restore.json");
  const dbPath = join(data, "sukuna.db");
  const sourcePath = (id: string) => {
    const name = backupFileName(id);
    return name === undefined ? undefined : join(dir, name);
  };
  const locked = async (run: () => Promise<void> | void) => {
    const lock = await acquireLock({ lockPath: join(state, "db.lock") });
    if (lock.isErr()) throw new Error(lock.error.message);
    try {
      await run();
    } finally {
      lock.value.release();
    }
  };

  return {
    async lockWorker(timeoutMs?: number) {
      const result = await acquireLock({
        lockPath: restoreWorkerLockPath(state),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      if (result.isOk()) return result.value;
      if (result.error.type === "lock_timeout") return null;
      throw new Error(result.error.message);
    },
    lookup(id: string) {
      if (readRestoreRequest(state)?.requestId === id) return { status: "pending" as const };
      const result = readRestoreReceipt(state, receiptWarning);
      return result?.requestId === id ? result : undefined;
    },
    recordResult: (result: RestoreStatus) => writeRestoreReceipt(state, result),
    readRequest: () => readRestoreRequest(state),
    hasRequest: () => existsSync(marker),
    backupExists(id: string) {
      const path = sourcePath(id);
      return path !== undefined && regularFile(path);
    },
    createRequest(request: RestoreRequest) {
      const temporary = join(state, `restore-${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(request), { mode: 0o600, flag: "wx" });
      try {
        linkSync(temporary, marker);
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
        throw error;
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    recordWorker(request: RestoreRequest, workerPid: number) {
      if (readRestoreRequest(state)?.requestId === request.requestId)
        replaceRestoreValue(marker, { ...request, workerPid });
    },
    clearRequest(request: RestoreRequest) {
      const current = readRestoreRequest(state);
      if (
        current &&
        current.requestId === request.requestId &&
        current.backupId === request.backupId &&
        current.requestedAt === request.requestedAt
      )
        rmSync(marker, { force: true });
    },
    recordDatabaseResult(status: RestoreStatus) {
      return locked(() => {
        const current = new Database(dbPath, { fileMustExist: true });
        try {
          putRestoreStatus(current, status);
        } finally {
          current.close();
        }
      });
    },
    replace(request: RestoreRequest, status: RestoreStatus) {
      return locked(async () => {
        const path = sourcePath(request.backupId);
        if (!path || !regularFile(path)) throw new Error("バックアップが見つかりません。");
        const temp = join(data, "restore-db.tmp");
        const snapshotName = beforeRestoreName(new Date(status.at));
        const snapshot = join(dir, snapshotName);
        const pendingBackup = join(dir, snapshotName + ".tmp");
        const current = new Database(dbPath, { fileMustExist: true });
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          await current.backup(pendingBackup);
          chmodSync(pendingBackup, 0o600);
          removeRestoreStaging(data);
          copyFileSync(path, temp);
          chmodSync(temp, 0o600);
          renameSync(pendingBackup, snapshot);
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (
              entry.isFile() &&
              entry.name !== snapshotName &&
              backupFileId(entry.name)?.kind === "before_restore"
            )
              rmSync(join(dir, entry.name));
          }
          const restored = new Database(temp, { fileMustExist: true });
          try {
            if (restored.pragma("integrity_check", { simple: true }) !== "ok")
              throw new Error("バックアップの整合性を確認できませんでした。");
            restored.pragma("journal_mode = DELETE");
            restored.exec("BEGIN IMMEDIATE");
            restored
              .prepare(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('flow_paused', 'true')",
              )
              .run();
            putRestoreStatus(restored, status);
            putRestoreGeneration(restored, request);
            restored.exec("COMMIT");
          } finally {
            restored.close();
          }
          const [checkpoint] = current.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
          if (checkpoint?.busy) throw new Error("データベースに接続中の処理があります。");
          current.close();
          rmSync(dbPath + "-wal", { force: true });
          rmSync(dbPath + "-shm", { force: true });
          renameSync(temp, dbPath);
        } finally {
          if (current.open) current.close();
          rmSync(pendingBackup, { force: true });
          removeRestoreStaging(data);
        }
      });
    },
  };
}
