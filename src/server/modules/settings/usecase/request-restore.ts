import { err, ok } from "neverthrow";
import type { RestoreRequest } from "../../../../shared/settings/restore-schema";
import type { LaunchdPort } from "../domain/launchd-port";

type RestoreLock = { release(): void };

export type RestoreRequestDependencies = {
  lockWorker(timeoutMs?: number): Promise<RestoreLock | null>;
  backupExists(id: string): boolean;
  hasRequest(): boolean;
  createRequest(request: RestoreRequest): boolean;
  recordWorker(request: RestoreRequest, pid: number): void;
  clearRequest(request: RestoreRequest): void;
  launchd: Pick<LaunchdPort, "registered" | "kickstart">;
  now(): number;
  id(): string;
};

const inProgress = {
  code: "conflict" as const,
  message: "復元が進行中です。再起動を待ってください。",
};

export async function requestRestore(backupId: string, deps: RestoreRequestDependencies) {
  const lock = await deps.lockWorker(0);
  if (!lock) return err(inProgress);
  try {
    if (deps.hasRequest()) return err(inProgress);
    if (!deps.backupExists(backupId))
      return err({
        code: "not_found" as const,
        message: "バックアップが見つかりません。設定を読み直してください。",
      });
    if (!(await deps.launchd.registered("restore")))
      return err({
        code: "conflict" as const,
        message: "復元の処理が登録されていません。導入のコマンドを実行し直してください。",
      });
    const request = { backupId, requestedAt: deps.now(), requestId: deps.id() };
    if (!deps.createRequest(request)) return err(inProgress);
    let pid: number | void;
    try {
      pid = await deps.launchd.kickstart("restore");
    } catch (error) {
      deps.clearRequest(request);
      throw error;
    }
    if (typeof pid === "number") deps.recordWorker(request, pid);
    return ok({ restarting: true as const, requestId: request.requestId });
  } finally {
    lock.release();
  }
}
