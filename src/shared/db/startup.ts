import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { err, ok, type Result } from "neverthrow";
import { applyMigrations, migrations, type Migration } from "./migrate";
import type { Directories } from "../env";
import { openDatabase, type OpenedDatabase } from "./open";
import { recoverRestore, restoreWorkerLockPath } from "./restore-state";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 500;

export type LockError = {
  type: "lock_timeout" | "lock_failed";
  message: string;
};

export type StartupError =
  | LockError
  | { type: "open_failed"; message: string }
  | { type: "migration_failed"; message: string };

export type LockHandle = {
  release: () => void;
};

export type AcquireLockOptions = {
  lockPath: string;
  pid?: number;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
};

export type StartupOptions = {
  directories: Directories;
  migrations?: Migration[];
  lock?: Omit<AcquireLockOptions, "lockPath">;
  restoreReceiptWarning?: (error: unknown) => void;
  now?: () => number;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function parsePid(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 0 ? pid : null;
}

function tryCreateLock(lockPath: string, pid: number): "created" | "exists" | "failed" {
  try {
    writeFileSync(lockPath, String(pid), { flag: "wx", mode: 0o600 });
    return "created";
  } catch (error) {
    return isErrno(error, "EEXIST") ? "exists" : "failed";
  }
}

function releaseLock(lockPath: string, pid: number): void {
  let holder: number | null;
  try {
    holder = parsePid(readFileSync(lockPath, "utf8"));
  } catch {
    return;
  }
  if (holder !== pid) return;
  rmSync(lockPath, { force: true });
}

function tryAcquireLock(
  lockPath: string,
  pid: number,
  alive: (pid: number) => boolean,
): Result<LockHandle | null, LockError> {
  let guard: Database.Database | undefined;
  let acquired = false;
  try {
    guard = new Database(`${lockPath}.guard`, { timeout: 0 });
    guard.exec("BEGIN IMMEDIATE");
    for (;;) {
      const created = tryCreateLock(lockPath, pid);
      if (created === "created") {
        const heldGuard = guard;
        acquired = true;
        return ok({
          release: () => {
            if (!heldGuard.open) return;
            try {
              releaseLock(lockPath, pid);
            } finally {
              heldGuard.close();
            }
          },
        });
      }
      if (created === "failed") {
        return err({
          type: "lock_failed",
          message: `ロックのファイルを作れませんでした: ${lockPath}`,
        });
      }

      const fd = openSync(lockPath, "r");
      try {
        const observed = fstatSync(fd);
        const contents = readFileSync(fd, "utf8");
        const holder = parsePid(contents);
        if (holder === null || !alive(holder)) {
          const current = statSync(lockPath);
          if (
            current.dev === observed.dev &&
            current.ino === observed.ino &&
            readFileSync(lockPath, "utf8") === contents
          ) {
            rmSync(lockPath);
            continue;
          }
        }
        return ok(null);
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    if (isErrno(error, "SQLITE_BUSY") || isErrno(error, "ENOENT")) return ok(null);
    return err({
      type: "lock_failed",
      message: `ロックを取得できませんでした: ${lockPath}: ${messageOf(error)}`,
    });
  } finally {
    if (!acquired) guard?.close();
  }
}

export async function acquireLock(
  options: AcquireLockOptions,
): Promise<Result<LockHandle, LockError>> {
  const pid = options.pid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const startedAt = now();

  for (;;) {
    const attempt = tryAcquireLock(options.lockPath, pid, alive);
    if (attempt.isErr()) return err(attempt.error);
    if (attempt.value !== null) return ok(attempt.value);
    if (now() - startedAt >= timeoutMs) {
      return err({
        type: "lock_timeout",
        message: `データベースのロックを ${timeoutMs / 1000} 秒待っても取れませんでした`,
      });
    }
    await sleep(intervalMs);
  }
}

export async function startDatabase(
  options: StartupOptions,
): Promise<Result<OpenedDatabase, StartupError>> {
  const { directories } = options;
  try {
    for (const directory of [directories.data, directories.state, directories.runtime])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    return err({
      type: "open_failed",
      message: `データの置き場所を作れませんでした: ${messageOf(error)}`,
    });
  }

  const lockResult = await acquireLock({
    lockPath: join(directories.state, "db.lock"),
    ...options.lock,
  });
  if (lockResult.isErr()) return err(lockResult.error);
  const lock = lockResult.value;

  let opened: OpenedDatabase | undefined;
  try {
    opened = openDatabase(directories);
    const migrationResult = applyMigrations(opened.sqlite, options.migrations ?? migrations);
    if (migrationResult.isErr()) {
      opened.close();
      return err({ type: "migration_failed", message: migrationResult.error.message });
    }
    if (existsSync(join(directories.state, "restore.json"))) {
      const worker = await acquireLock({
        ...options.lock,
        lockPath: restoreWorkerLockPath(directories.state),
        timeoutMs: 0,
      });
      if (worker.isOk()) {
        try {
          recoverRestore(
            opened.sqlite,
            directories,
            options.now ?? options.lock?.now ?? Date.now,
            options.lock?.isProcessAlive ?? isProcessAlive,
            options.restoreReceiptWarning,
          );
        } finally {
          worker.value.release();
        }
      } else if (worker.error.type !== "lock_timeout") {
        opened.close();
        return err(worker.error);
      }
    }
    return ok(opened);
  } catch (error) {
    if (opened?.sqlite.open) opened.close();
    return err({
      type: "open_failed",
      message: `データベースを開けませんでした: ${messageOf(error)}`,
    });
  } finally {
    lock.release();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
