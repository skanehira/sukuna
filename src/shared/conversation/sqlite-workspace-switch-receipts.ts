import type Database from "better-sqlite3";
import type { WorkspaceSwitchAttempt, WorkspaceSwitchReceipt } from "../ipc";

const prefix = "runner-workspace-switch:";

export function readWorkspaceSwitchReceipt(
  sqlite: Database.Database,
  attempt: WorkspaceSwitchAttempt,
  now: number,
): WorkspaceSwitchReceipt | null {
  if (attempt.expires_at <= now) throw new Error("作業場所の切り替えの記録が期限切れです。");
  const row = sqlite.prepare("SELECT value FROM settings WHERE key=?").get(prefix + attempt.id) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as WorkspaceSwitchReceipt) : null;
}

export function writeWorkspaceSwitchReceipt(
  sqlite: Database.Database,
  attempt: WorkspaceSwitchAttempt,
  receipt: WorkspaceSwitchReceipt,
  now: number,
): void {
  if (attempt.expires_at <= now) throw new Error("作業場所の切り替えの記録が期限切れです。");
  sqlite
    .prepare("DELETE FROM settings WHERE key GLOB ? AND json_extract(value, '$.expiresAt') <= ?")
    .run(prefix + "*", now);
  sqlite
    .prepare("INSERT INTO settings (key,value) VALUES (?,?)")
    .run(prefix + attempt.id, JSON.stringify({ ...receipt, expiresAt: attempt.expires_at }));
}
