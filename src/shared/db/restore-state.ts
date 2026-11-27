import type Database from "better-sqlite3";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  restoreReceiptSchema,
  restoreRequestSchema,
  restoreStatusSchema,
  type RestoreRequest,
  type RestoreStatus,
} from "../settings/restore-schema";

export const restoreWorkerLockPath = (home: string) => join(home, "restore-worker.lock");

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function replaceRestoreValue(path: string, value: unknown): void {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readRestoreRequest(home: string): RestoreRequest | undefined {
  const raw = readJson(join(home, "restore.json"));
  return raw === undefined ? undefined : restoreRequestSchema.parse(raw);
}

export function readRestoreReceipt(home: string, warning: (error: unknown) => void = () => {}) {
  try {
    return restoreReceiptSchema.safeParse(readJson(join(home, "restore-result.json"))).data;
  } catch (error) {
    warning(error);
    return undefined;
  }
}

export function writeRestoreReceipt(home: string, result: RestoreStatus): void {
  if (result.requestId) replaceRestoreValue(join(home, "restore-result.json"), result);
}

export function putRestoreStatus(sqlite: Database.Database, value: RestoreStatus): void {
  sqlite
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_restore', ?)")
    .run(JSON.stringify(value));
}

export function recoverRestore(
  sqlite: Database.Database,
  home: string,
  now: () => number,
  alive: (pid: number) => boolean,
  receiptWarning: (error: unknown) => void = () => {},
): void {
  const request = readRestoreRequest(home);
  if (!request || (request.workerPid !== undefined && alive(request.workerPid))) return;
  const receipt = readRestoreReceipt(home, receiptWarning);
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key='last_restore' AND json_valid(value)")
    .get() as { value: string } | undefined;
  const existing = row ? restoreStatusSchema.safeParse(JSON.parse(row.value)).data : undefined;
  const completed = request.requestId
    ? existing?.requestId === request.requestId
    : existing?.backupId === request.backupId && existing.at >= request.requestedAt;
  const result =
    receipt && receipt.requestId === request.requestId
      ? receipt
      : completed && existing
        ? existing
        : {
            backupId: request.backupId,
            at: Math.max(now(), request.requestedAt),
            status: "failed" as const,
            message: "復元の途中で止まりました",
            ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
          };
  putRestoreStatus(sqlite, result);
  try {
    writeRestoreReceipt(home, result);
  } catch (error) {
    receiptWarning(error);
  }
  removeRestoreStaging(home);
  rmSync(join(home, "restore.json"), { force: true });
}

export function removeRestoreStaging(home: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    rmSync(join(home, "restore-db.tmp" + suffix), { force: true });
}
