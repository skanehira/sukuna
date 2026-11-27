import { backupDay, backupFileName } from "../../../../shared/settings/backup-paths";
import type { Clock } from "../../conversation/domain/clock";

type BackupFiles = {
  prepare(): void;
  newest(): { name: string; writtenAt: number } | undefined;
  write(day: string): Promise<void>;
  keepLatest(count: number): void;
  record(at: number, error: string | null): void;
};

const dayMs = 86_400_000;

function nextBackupAt(at: number, includeCurrent: boolean): number {
  const next = new Date(at);
  next.setHours(3, 0, 0, 0);
  if (next.getTime() < at || (!includeCurrent && next.getTime() === at))
    next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function startBackup(
  files: BackupFiles,
  clock: Clock,
  {
    startedAt = clock.now(),
    failure = () => {},
  }: {
    startedAt?: number;
    failure?: (error: unknown) => void;
  } = {},
) {
  let cancel = () => {};
  let stopped = false;
  let pending: Promise<void>;
  const firstDueAt = nextBackupAt(startedAt, true);
  const take = async (at = clock.now()) => {
    let message: string | null = null;
    try {
      await files.write(backupDay(new Date(at)));
      files.keepLatest(7);
    } catch (error) {
      message = error instanceof Error ? error.message : "バックアップを保存できませんでした。";
      failure(error);
    }
    files.record(at, message);
  };
  const schedule = (due?: number) => {
    if (stopped) return;
    const now = clock.now();
    const next = due ?? nextBackupAt(now, false);
    cancel = clock.setTimeout(
      () => {
        pending = take().catch(failure).finally(schedule);
        return pending;
      },
      Math.max(0, next - now),
    );
  };
  let firstTimer: number | undefined;
  pending = Promise.resolve()
    .then(async () => {
      if (stopped) return;
      files.prepare();
      const latest = files.newest();
      const at = clock.now();
      if (at < firstDueAt) firstTimer = firstDueAt;
      const today = backupFileName(backupDay(new Date(at)));
      if (
        !latest ||
        at - latest.writtenAt > dayMs ||
        (firstDueAt <= at && (latest.name !== today || latest.writtenAt < firstDueAt))
      )
        await take(at);
    })
    .catch(failure)
    .finally(() => schedule(firstTimer));
  return {
    ready: pending,
    async stop() {
      stopped = true;
      cancel();
      await pending;
    },
  };
}
